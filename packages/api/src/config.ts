const env = process.env;

// DEFAULTS
const DEFAULT_APP_TYPE = 'api';
const DEFAULT_EXPRESS_SESSION = 'hyperdx is cool 👋';
const DEFAULT_FRONTEND_URL = `http://localhost:${env.HYPERDX_APP_PORT}`;

export const NODE_ENV = env.NODE_ENV as string;

export const APP_TYPE = (env.APP_TYPE || DEFAULT_APP_TYPE) as
  | 'api'
  | 'scheduled-task';
export const CODE_VERSION = env.CODE_VERSION ?? '';
export const EXPRESS_SESSION_SECRET = (env.EXPRESS_SESSION_SECRET ||
  DEFAULT_EXPRESS_SESSION) as string;
export const FRONTEND_URL = (env.FRONTEND_URL ||
  DEFAULT_FRONTEND_URL) as string;
const HYPERDX_IMAGE = env.HYPERDX_IMAGE;
export const IS_APP_IMAGE = HYPERDX_IMAGE === 'hyperdx';
export const IS_ALL_IN_ONE_IMAGE = HYPERDX_IMAGE === 'all-in-one-auth';
export const IS_LOCAL_IMAGE = HYPERDX_IMAGE === 'all-in-one-noauth';
export const INGESTION_API_KEY = env.INGESTION_API_KEY ?? '';
export const HYPERDX_API_KEY = env.HYPERDX_API_KEY as string;
export const HYPERDX_LOG_LEVEL = env.HYPERDX_LOG_LEVEL as string;
export const IS_CI = NODE_ENV === 'test';
export const IS_DEV = NODE_ENV === 'development';
export const IS_PROD = NODE_ENV === 'production';
export const MINER_API_URL = env.MINER_API_URL as string;
export const MONGO_URI = env.MONGO_URI;
export const OTEL_SERVICE_NAME = env.OTEL_SERVICE_NAME as string;
export const PORT = Number.parseInt(env.PORT as string);
export const OPAMP_PORT = Number.parseInt(env.OPAMP_PORT as string);
export const USAGE_STATS_ENABLED = env.USAGE_STATS_ENABLED !== 'false';
export const RUN_SCHEDULED_TASKS_EXTERNALLY =
  env.RUN_SCHEDULED_TASKS_EXTERNALLY === 'true';

// Only for single container local deployments, disable authentication
export const IS_LOCAL_APP_MODE =
  env.IS_LOCAL_APP_MODE === 'DANGEROUSLY_is_local_app_mode💀';

// Only used to bootstrap empty instances
export const DEFAULT_CONNECTIONS = env.DEFAULT_CONNECTIONS;
export const DEFAULT_SOURCES = env.DEFAULT_SOURCES;

// FOR CI ONLY
export const CLICKHOUSE_HOST = env.CLICKHOUSE_HOST as string;
export const CLICKHOUSE_USER = env.CLICKHOUSE_USER as string;
export const CLICKHOUSE_PASSWORD = env.CLICKHOUSE_PASSWORD as string;

// OIDC / Keycloak Configuration
export const OIDC_ENABLED = env.OIDC_ENABLED === 'true';
export const OIDC_ISSUER_BASE_URL = env.OIDC_ISSUER_BASE_URL as string; // e.g. https://keycloak.example.com/realms/hyperdx
export const OIDC_CLIENT_ID = env.OIDC_CLIENT_ID as string;
export const OIDC_CLIENT_SECRET = env.OIDC_CLIENT_SECRET as string;
export const OIDC_CALLBACK_URL =
  (env.OIDC_CALLBACK_URL ||
    `${env.FRONTEND_URL || DEFAULT_FRONTEND_URL}/api/auth/oidc/callback`) as string;
export const OIDC_SCOPE = (env.OIDC_SCOPE || 'openid profile email') as string;
// Mapping from Keycloak realm/client roles to HyperDX roles
// Format: JSON object { "keycloak_role": "hdx_role" }
// Default: admin→admin, member→member, viewer→viewer
export const OIDC_ROLE_MAPPING = env.OIDC_ROLE_MAPPING
  ? JSON.parse(env.OIDC_ROLE_MAPPING)
  : { admin: 'admin', member: 'member', viewer: 'viewer' };
export const OIDC_DEFAULT_ROLE = (env.OIDC_DEFAULT_ROLE || 'member') as
  | 'admin'
  | 'member'
  | 'viewer';
// Which Keycloak token claim contains roles (default: realm_access.roles)
export const OIDC_ROLES_CLAIM = (env.OIDC_ROLES_CLAIM ||
  'realm_access.roles') as string;

// AI Assistant
// Provider-agnostic configuration (preferred)
export const AI_PROVIDER = env.AI_PROVIDER as string; // 'anthropic' | 'openai'
export const AI_API_KEY = env.AI_API_KEY as string;
export const AI_BASE_URL = env.AI_BASE_URL as string;
export const AI_MODEL_NAME = env.AI_MODEL_NAME as string;

// Legacy Anthropic-specific configuration (backward compatibility)
export const ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY as string;
