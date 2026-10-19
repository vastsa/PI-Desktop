/**
 * Fixed constants owned by first-party desktop integrations: the Host secret
 * references their credentials are stored under, and the addresses those
 * credentials are spent on.
 */
export const JEV_API_KEY_SECRET_REF = "secret:app:typesafe-jev";

/** Official TypeSafe API root and the System One operation behind Jev. */
export const TYPESAFE_SYSTEM_ONE_BASE_URL = "https://api.typesafe.ai/v1";
export const TYPESAFE_SYSTEM_ONE_URL = `${TYPESAFE_SYSTEM_ONE_BASE_URL}/systemone`;
export const TYPESAFE_JEV_MODEL_ID = "jev-latest";
