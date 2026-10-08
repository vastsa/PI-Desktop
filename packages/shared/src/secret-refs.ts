/**
 * Fixed constants owned by first-party desktop integrations: the Host secret
 * references their credentials are stored under, and the addresses those
 * credentials are spent on.
 */
export const JEV_API_KEY_SECRET_REF = "secret:app:typesafe-jev";

/**
 * The TypeSafe System One endpoint behind Jev, and the classifier it asks.
 *
 * The settings key check calls this address. The Agent's `JevClassify` tool
 * reaches the same one through pi-ai's `typesafe` provider, whose published
 * base URL resolves to it; if that address ever moves in pi-ai, this constant
 * is what the check has to follow.
 */
export const TYPESAFE_SYSTEM_ONE_URL = "https://api.typesafe.ai/v1/systemone";
export const TYPESAFE_JEV_MODEL_ID = "jev-latest";
