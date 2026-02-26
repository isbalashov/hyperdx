import type { UserRole } from '@/models/user';
import User from '@/models/user';
import Team from '@/models/team';
import { createTeam } from '@/controllers/team';
import { setupTeamDefaults } from '@/setupDefaults';
import logger from '@/utils/logger';

interface OidcUserInfo {
  email: string;
  name: string;
  oidcSubject: string;
  oidcIssuer: string;
  role: UserRole;
}

/**
 * Find an existing user by OIDC subject+issuer, or by email.
 * If the user doesn't exist, auto-provision them (creating a team if needed).
 */
export async function findOrCreateOidcUser(info: OidcUserInfo) {
  // 1. Try to find by OIDC subject (most reliable)
  let user = await User.findOne({
    oidcSubject: info.oidcSubject,
    oidcIssuer: info.oidcIssuer,
  });

  if (user) {
    // Update role from IdP on each login (roles may change in Keycloak)
    if (user.role !== info.role) {
      user.role = info.role;
      await user.save();
    }
    return user;
  }

  // 2. Try to find by email (link existing password account to OIDC)
  user = await User.findOne({ email: info.email.toLowerCase() });

  if (user) {
    // Link OIDC identity to existing user
    user.oidcSubject = info.oidcSubject;
    user.oidcIssuer = info.oidcIssuer;
    user.role = info.role;
    if (!user.name || user.name === user.email) {
      user.name = info.name;
    }
    await user.save();
    return user;
  }

  // 3. Auto-provision new user
  // Ensure a team exists (for OSS single-team mode)
  let team = await Team.findOne({});
  if (!team) {
    team = await createTeam({
      name: `${info.name}'s Team`,
      collectorAuthenticationEnforced: true,
    });
    // Set up default connections and sources
    try {
      await setupTeamDefaults(team._id.toString());
    } catch (error) {
      logger.error({ err: error }, 'Failed to setup team defaults for OIDC user');
    }
  }

  user = new User({
    email: info.email.toLowerCase(),
    name: info.name,
    team: team._id,
    role: info.role,
    oidcSubject: info.oidcSubject,
    oidcIssuer: info.oidcIssuer,
  });

  await user.save();

  logger.info(
    { userId: user._id, email: info.email },
    'Auto-provisioned new OIDC user',
  );

  return user;
}

/**
 * Map Keycloak roles to an HyperDX role using the configured mapping.
 * Uses highest-privilege match: admin > member > viewer.
 */
export function mapOidcRolesToHdxRole(
  keycloakRoles: string[],
  roleMapping: Record<string, string>,
  defaultRole: UserRole,
): UserRole {
  const ROLE_PRIORITY: UserRole[] = ['admin', 'member', 'viewer'];

  // Invert: build hdxRole -> keycloak role names set
  const hdxToKeycloak = new Map<string, Set<string>>();
  for (const [kcRole, hdxRole] of Object.entries(roleMapping)) {
    if (!hdxToKeycloak.has(hdxRole)) {
      hdxToKeycloak.set(hdxRole, new Set());
    }
    hdxToKeycloak.get(hdxRole)!.add(kcRole);
  }

  // Check in priority order (highest privilege first)
  for (const hdxRole of ROLE_PRIORITY) {
    const matchingKcRoles = hdxToKeycloak.get(hdxRole);
    if (matchingKcRoles) {
      for (const kcRole of keycloakRoles) {
        if (matchingKcRoles.has(kcRole)) {
          return hdxRole;
        }
      }
    }
  }

  return defaultRole;
}
