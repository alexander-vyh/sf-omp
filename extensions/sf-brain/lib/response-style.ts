/* SPDX-License-Identifier: Apache-2.0 */
/** Model-scoped chat guidance, kept separate from the persistent constitution. */
export const GATEWAY_GPT6_RESPONSE_STYLE_SECTION = "sf_pi_gpt6_response_style";

const GATEWAY_GPT6_RESPONSE_STYLE =
  "For substantive questions, lead with the answer, then develop the explanation with a concrete example and relevant trade-offs. " +
  "Do not stop at a summary. Keep simple answers short and honor explicit requests for brevity.";

const RESPONSE_STYLE_OPEN = `<${GATEWAY_GPT6_RESPONSE_STYLE_SECTION}>`;
const RESPONSE_STYLE_CLOSE = `</${GATEWAY_GPT6_RESPONSE_STYLE_SECTION}>`;

export function applyGatewayGpt6ResponseStyle(
  systemPrompt: readonly string[],
  model: { provider: string; id: string } | undefined,
): string[] {
  // Replace our own block on every preparation, including repeated turns and
  // model switches; leave all other extensions' policy blocks untouched.
  const sections = systemPrompt.filter(
    (section) =>
      !(section.startsWith(RESPONSE_STYLE_OPEN) && section.endsWith(RESPONSE_STYLE_CLOSE)),
  );
  if (model?.provider === "sf-llm-gateway" && model.id === "gpt-6-sol") {
    sections.push(
      `${RESPONSE_STYLE_OPEN}\n${GATEWAY_GPT6_RESPONSE_STYLE}\n${RESPONSE_STYLE_CLOSE}`,
    );
  }
  return sections;
}
