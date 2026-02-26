import passport from 'passport';
import {
  Strategy as OpenIDConnectStrategy,
  type Profile,
  type VerifyCallback,
  type VerifyFunction,
} from 'passport-openidconnect';

import * as config from '@/config';
import {
  findOrCreateOidcUser,
  mapOidcRolesToHdxRole,
} from '@/controllers/oidcUser';
import logger from '@/utils/logger';

/**
 * Configures the OIDC (Keycloak) passport strategy.
 * Only initializes when OIDC_ENABLED=true and all required config is present.
 */
export function configureOidcStrategy() {
  if (!config.OIDC_ENABLED) {
    logger.info('OIDC authentication is disabled');
    return;
  }

  if (
    !config.OIDC_ISSUER_BASE_URL ||
    !config.OIDC_CLIENT_ID ||
    !config.OIDC_CLIENT_SECRET
  ) {
    logger.error(
      'OIDC is enabled but missing required configuration (OIDC_ISSUER_BASE_URL, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET)',
    );
    return;
  }

  // Standard Keycloak OIDC endpoints derived from the issuer URL
  const issuer = config.OIDC_ISSUER_BASE_URL.replace(/\/$/, '');

  // The verify callback with full token params.
  // We use a cast because the VerifyFunction union has many overloads and
  // TypeScript cannot narrow it from the number of arguments alone.
  const verify = ((
    _iss: string,
    profile: Profile,
    _context: object,
    idToken: string | object,
    accessToken: string | object,
    _refreshToken: string,
    params: any,
    done: VerifyCallback,
  ) => {
    handleOidcVerify(issuer, profile, idToken, accessToken, params, done);
  }) as VerifyFunction;

  passport.use(
    'oidc',
    new OpenIDConnectStrategy(
      {
        issuer,
        authorizationURL: `${issuer}/protocol/openid-connect/auth`,
        tokenURL: `${issuer}/protocol/openid-connect/token`,
        userInfoURL: `${issuer}/protocol/openid-connect/userinfo`,
        clientID: config.OIDC_CLIENT_ID,
        clientSecret: config.OIDC_CLIENT_SECRET,
        callbackURL: config.OIDC_CALLBACK_URL,
        scope: config.OIDC_SCOPE.split(' '),
      },
      verify,
    ),
  );

  logger.info(
    { issuer, clientId: config.OIDC_CLIENT_ID },
    'OIDC (Keycloak) strategy configured',
  );
}

/**
 * Core OIDC verification logic extracted for clarity.
 */
async function handleOidcVerify(
  issuer: string,
  profile: Profile,
  idToken: string | object,
  accessToken: string | object,
  params: any,
  done: VerifyCallback,
) {
  try {
    const email =
      profile.emails?.[0]?.value ??
      (profile as any)._json?.email ??
      profile.username;
    const displayName =
      profile.displayName ??
      [profile.name?.givenName, profile.name?.familyName]
        .filter(Boolean)
        .join(' ') ??
      email;

    if (!email) {
      logger.error({ profile }, 'OIDC profile does not contain an email');
      return done(new Error('No email found in OIDC profile'), undefined);
    }

    // Extract roles from the ID token / access token claims
    const idTokenClaims =
      typeof params?.id_token === 'string'
        ? JSON.parse(
            Buffer.from(
              params.id_token.split('.')[1],
              'base64',
            ).toString(),
          )
        : {};
    const accessTokenClaims =
      typeof accessToken === 'string'
        ? JSON.parse(
            Buffer.from(
              accessToken.split('.')[1],
              'base64',
            ).toString(),
          )
        : {};

    const keycloakRoles = extractRolesFromClaims(
      { ...idTokenClaims, ...accessTokenClaims },
      config.OIDC_ROLES_CLAIM,
    );

    const hdxRole = mapOidcRolesToHdxRole(
      keycloakRoles,
      config.OIDC_ROLE_MAPPING,
      config.OIDC_DEFAULT_ROLE,
    );

    const user = await findOrCreateOidcUser({
      email: email.toLowerCase(),
      name: displayName,
      oidcSubject: profile.id,
      oidcIssuer: issuer,
      role: hdxRole,
    });

    // Attach the raw id_token so we can send it as id_token_hint on logout
    const rawIdToken =
      typeof idToken === 'string'
        ? idToken
        : typeof params?.id_token === 'string'
          ? params.id_token
          : undefined;
    if (rawIdToken) {
      (user as any).oidcIdToken = rawIdToken;
    }

    logger.info(
      {
        userId: user._id,
        email,
        role: hdxRole,
        oidcSubject: profile.id,
      },
      'OIDC login successful',
    );

    return done(null, user);
  } catch (err) {
    logger.error({ err }, 'OIDC authentication error');
    return done(err as Error, undefined);
  }
}

/**
 * Extracts roles from token claims using a dot-notation path.
 * E.g. "realm_access.roles" → claims.realm_access.roles
 */
function extractRolesFromClaims(
  claims: Record<string, any>,
  claimPath: string,
): string[] {
  const parts = claimPath.split('.');
  let current: any = claims;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') {
      return [];
    }
    current = current[part];
  }
  return Array.isArray(current) ? current : [];
}
