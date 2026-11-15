/* SPDX-License-Identifier: Apache-2.0 */
/** Invented credentials; never accepted by a provider and never sent to one. */
export const providers = ["openai", "anthropic"] as const;
export const initialApiKey = "offline-fixture-api-key-initial";
export const updatedApiKey = "offline-fixture-api-key-updated";
export const initialAccess = "offline-fixture-oauth-access-initial";
export const updatedAccess = "offline-fixture-oauth-access-updated";
export const refreshMaterial = "offline-fixture-refresh-never-share";
export const fixtureEmail = "offline-auth-smoke@example.invalid";
export const reservePct = 73;
export const accountPolicy = {
  provider: "anthropic",
  account: { email: fixtureEmail },
  priority: 41,
  reservePct: 67,
};
