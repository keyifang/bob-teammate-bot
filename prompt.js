// Assembly of the reply prompt.
//
// Extracted from the webhook handler so the memory contract can be tested
// directly: the three tiers are injected broadest-first (C, then B, then A),
// and nothing from another chat can reach this chat's prompt (FR-04 to FR-07).
//
// Every input is passed in explicitly - this module reads no database and no
// global, so a leak between chats can only come from the caller.

/**
 * @param {object} input
 * @param {string} input.bobName
 * @param {string} [input.ownerName]      owner of the chat (tier C subject)
 * @param {string} [input.crossChatSummary] tier C
 * @param {string} [input.summary]        tier B
 * @param {string} [input.transcript]     tier A, already formatted
 * @param {string} [input.latest]         the message being answered, if it is
 *                                        not already the last line of transcript
 * @param {boolean} [input.firstContact]  first message in a private chat
 * @returns {string}
 */
export function buildReplyPrompt({
  bobName,
  ownerName,
  crossChatSummary,
  summary,
  transcript,
  latest,
  firstContact = false,
}) {
  const sections = [];

  if (crossChatSummary && ownerName) {
    sections.push(
      `What you know about ${ownerName} from their other chats with you:\n${crossChatSummary}`
    );
  }
  if (summary) {
    sections.push(`Summary of this chat so far:\n${summary}`);
  }
  if (transcript) {
    sections.push(`Recent messages:\n${transcript}`);
  }
  if (latest) {
    sections.push(`Newest message to answer:\n${latest}`);
  }
  if (firstContact) {
    sections.push(
      "This is your first message with this person, so greet them briefly as " +
        `${bobName}, an AI teammate, in 2-3 sentences, and then answer their message.`
    );
  }

  sections.push(
    `Reply as ${bobName}, responding naturally to the latest message.`
  );

  return sections.join("\n\n");
}
