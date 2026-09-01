/**
 * fix/private-alpha-email-review-detail-and-general-mail-understanding: a single, reusable,
 * domain-agnostic email-content cleaner and secret-redactor. Used everywhere raw Gmail content
 * (decoded from either a text/plain or text/html MIME part) needs to become safe, readable text —
 * the "details for 3" review-detail command, the LLM email-understanding call, and the deterministic
 * classifier's own body input all run through this SAME pipeline, so a redacted verification code
 * never reaches an LLM prompt in one place while leaking through in another.
 *
 * Deliberately general: no per-sender/per-platform special-casing. Every step here (HTML-to-text,
 * quoted-reply stripping, footer/tracking-noise stripping, secret redaction, invisible-character
 * removal) is a structural pattern that applies to any email, not a job-search-specific rule.
 */

export const DEFAULT_EMAIL_DETAIL_LENGTH = 1200;
export const FULL_EMAIL_DETAIL_LENGTH = 4000;
export const CLASSIFIER_BODY_LENGTH = 3000;

export interface CleanEmailBodyOptions {
  /** True when the raw text was decoded from a text/html MIME part (or is HTML for any other
   * reason) - runs HTML-to-readable-text conversion first. False/omitted assumes already-plain text. */
  isHtml?: boolean;
  /** Output cap in characters, applied last. Defaults to DEFAULT_EMAIL_DETAIL_LENGTH. */
  maxLength?: number;
}

/**
 * The main entry point - raw decoded email body in, safe/readable/capped/redacted text out.
 * Order matters: HTML must become text before quote/footer stripping can recognize line-based
 * patterns, redaction must run before truncation so a secret never survives by landing just past
 * the cap, and whitespace collapse runs last so it doesn't interfere with the line-based steps
 * before it.
 */
export function cleanEmailBodyForDisplay(rawBody: string, options: CleanEmailBodyOptions = {}): string {
  const maxLength = options.maxLength ?? DEFAULT_EMAIL_DETAIL_LENGTH;

  let text = options.isHtml ? htmlToReadableText(rawBody) : rawBody;
  text = decodeHtmlEntities(text);
  text = removeInvisibleCharacters(text);
  text = stripQuotedReplyChain(text);
  text = stripFooterNoise(text);
  text = redactSecrets(text);
  text = collapseWhitespace(text);

  return truncateWithEllipsis(text, maxLength);
}

/**
 * Converts an HTML email body to readable plain text. <script>/<style> blocks are removed
 * ENTIRELY (tag and content - their content is markup/CSS/JS, never real message text), block-
 * level tags become line breaks so paragraphs don't get jammed into one run-on line once tags are
 * stripped, and every remaining tag is dropped.
 */
function htmlToReadableText(html: string): string {
  return html
    .replace(/<(script|style|head|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, "\n")
    .replace(/<(p|div|li)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
}

const HTML_ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  "#39": "'",
  nbsp: " "
};

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&(amp|lt|gt|quot|apos|#39|nbsp);/g, (match, name: string) => HTML_ENTITY_MAP[name] ?? match)
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, code: string) => String.fromCodePoint(parseInt(code, 16)));
}

// Control chars, zero-width/format characters, BOM, bidi override marks, soft hyphen - real
// invisible-character spam-filter-evasion tricks, never legitimate visible content. Mirrors
// apps/api/src/utils/text.ts's INVISIBLE_CHAR_PATTERN (packages/core cannot depend on apps/api,
// so this is intentionally a second copy of the same pattern, not a drifted redefinition). Built
// from \u escape sequences (never a literal invisible character pasted into source) - an actually-
// invisible character in source code is unreviewable and one accidental edit from corruption.
const INVISIBLE_CHAR_PATTERN = new RegExp(
  "[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F\\u00AD\\u200B-\\u200F\\u2028\\u2029\\u202A-\\u202E\\u2060-\\u2064\\uFEFF\\uFFF9-\\uFFFB]",
  "g"
);

function removeInvisibleCharacters(text: string): string {
  return text.replace(INVISIBLE_CHAR_PATTERN, "");
}

// A generic, structural marker set for "everything below this line is a quoted prior message, not
// the sender's own new content" - an email client's own reply-quoting conventions (Gmail, Outlook,
// Apple Mail), never a sender-specific pattern. Cuts the text at the FIRST match found, since
// everything after it is, by definition, older content already seen in a prior message.
const QUOTE_MARKERS: RegExp[] = [
  /^\s*On .{0,120} wrote:\s*$/im,
  /^-{2,}\s*Original Message\s*-{2,}/im,
  /^From:\s*.{0,200}\nSent:\s*.{0,200}\nTo:\s*/im,
  /^_{5,}\s*$/m,
  /^>{1,}.*(\n>{1,}.*){3,}/m
];

function stripQuotedReplyChain(text: string): string {
  let cutIndex = text.length;
  for (const pattern of QUOTE_MARKERS) {
    const match = pattern.exec(text);
    if (match && match.index < cutIndex) {
      cutIndex = match.index;
    }
  }
  return text.slice(0, cutIndex);
}

// Common footer/legal/tracking boilerplate that trails the real message content in bulk and
// transactional email alike - a structural convention (CAN-SPAM-style unsubscribe blocks, mailing-
// address disclosures, "you received this because" explanations), never a per-sender rule. Cuts at
// the FIRST match, same reasoning as quote stripping: this is always trailing noise, never content
// worth keeping past that point.
const FOOTER_MARKERS: RegExp[] = [
  /\bunsubscribe\b/i,
  /\bview (this email )?in (your )?browser\b/i,
  /\byou('re| are) receiving this (email|message) because\b/i,
  /\bthis email was sent to\b/i,
  /\bupdate your (email )?preferences\b/i,
  /\bmanage your (email )?(subscription|preferences)\b/i,
  /\ball rights reserved\b/i,
  /\bthis is an automated (email|message)[,.]? (please )?do not reply\b/i
];

function stripFooterNoise(text: string): string {
  let cutIndex = text.length;
  for (const pattern of FOOTER_MARKERS) {
    const match = pattern.exec(text);
    if (match && match.index < cutIndex) {
      cutIndex = match.index;
    }
  }
  return text.slice(0, cutIndex);
}

/**
 * Redacts one-time codes, verification/security codes, password-reset codes and links, and other
 * short-lived secrets - general phrase+pattern based, not a stored-value denylist (there is no
 * list of real codes to match against; a code is only ever seen once). Multiple passes: (1) a
 * labeled numeric/alphanumeric code near a security keyword within a short window in either order,
 * (2) a bare password-reset/verification link's token, (3) a long unlabeled mixed alphanumeric run
 * typical of a raw token - so redaction never depends on one exact label wording.
 */
// Label words that, appearing near a short digit/alphanumeric run, mean that run is very likely a
// one-time code/PIN/token rather than an ordinary number (an order number, a price, a year).
const SECRET_LABEL = "(?:verification|security|authentication|access|confirmation|login|sign-?in|one-?time|otp|2fa|two-factor|pin|passcode|token|code|c[oó]digo(?: de)?(?: verificaci[oó]n| seguridad| acceso| confirmaci[oó]n)?)";

export function redactSecrets(text: string): string {
  let result = text;

  // A code-shaped token: either all digits, or alphanumeric WITH at least one digit (so a plain
  // English word near the label word - "code is valid for 10 minutes" - can never match; a real
  // code/token is never a pure alphabetic word).
  const CODE_TOKEN = "(?:[0-9]{4,8}|(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]{6,10})";

  // Label appears BEFORE the code (the common case): "verification code: 482913", "your code is
  // Xk93PqLm2z", "PIN 4821".
  result = result.replace(new RegExp(`\\b(${SECRET_LABEL}\\b[^\\n]{0,30}?[:\\s]\\s*)(${CODE_TOKEN})\\b`, "gi"), "$1[redacted]");

  // Label appears AFTER the code: "482913 is your verification code", "Xk93PqLm2z es tu código".
  result = result.replace(new RegExp(`\\b(${CODE_TOKEN})\\b([^\\n]{0,30}?\\b(?:is your|es tu|es el)\\b[^\\n]{0,20}?\\b${SECRET_LABEL}\\b)`, "gi"), "[redacted]$2");

  // A bare password-reset/verification link - redact just the token portion of the URL so the
  // link's structure stays visible but unusable.
  result = result.replace(/(https?:\/\/[^\s]+?[?&](?:token|code|key|otp)=)[^\s&]+/gi, "$1[redacted]");

  // A long (20+ char) mixed alphanumeric run with no spaces, unlabeled - typical of a raw reset/
  // API token pasted into the body outside a URL. Never matches ordinary words or short identifiers.
  result = result.replace(/\b(?=[A-Za-z0-9_-]{20,}\b)(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{20,}\b/g, "[redacted]");

  return result;
}

function collapseWhitespace(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line, index, lines) => line.length > 0 || (index > 0 && lines[index - 1]!.length > 0))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncateWithEllipsis(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength).trimEnd()}...` : text;
}
