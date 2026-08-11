export interface EmailRuleLike {
  id: string;
  name: string;
  status: string;
  query?: string | null;
}

export interface EmailRuleSelectionCandidate {
  id: string;
  name: string;
  status: string;
}

export interface MultiEmailRuleTargetResolution<T extends EmailRuleLike> {
  matches: T[];
  ambiguousTargets: Array<{ target: string; candidates: T[] }>;
  unmatchedTargets: string[];
}

export function normalizeConversationText(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ");
}

export function cleanEmailRuleTarget(value: string): string {
  return cleanSelectionKeyword(value)
    .replace(
      /\b(rule|rules|regla|reglas|gmail|email|emails|correo|correos|mail|mails|tracking|it|this|that|new|what|where|when|will|would|does|do|let|know|tell|notify|notification|arrive|arrives|saved|actions?|events?|reviews?)\b/gi,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();
}

export function findEmailRulesByTarget<T extends EmailRuleLike>(rules: T[], target: string): T[] {
  const rawTargetKey = normalizeConversationText(target);
  const exactNameMatches = rules.filter((rule) => normalizeConversationText(rule.name) === rawTargetKey);

  if (exactNameMatches.length > 0) {
    return exactNameMatches;
  }

  const targetKey = normalizeConversationText(cleanSelectionKeyword(target));
  const targetTokens = meaningfulRuleTokens(targetKey);

  if (targetTokens.length === 0) {
    return [];
  }

  return rules.filter((rule) => {
    const haystack = normalizeConversationText(`${rule.name} ${rule.query ?? ""}`);
    return targetTokens.every((token) => haystack.includes(token));
  });
}

export function splitEmailRuleTargets(target: string): string[] {
  const cleaned = cleanEmailRuleTarget(target);

  if (!cleaned) {
    return [];
  }

  return uniqueStrings(
    cleaned
      .split(/\s*(?:,|;|\s+(?:and|y|e|i)\s+)\s*/i)
      .map(cleanEmailRuleTarget)
      .filter((item) => item.length > 0)
  );
}

export function resolveMultipleEmailRuleTargets<T extends EmailRuleLike>(
  rules: T[],
  targets: string[]
): MultiEmailRuleTargetResolution<T> {
  const matchesById = new Map<string, T>();
  const ambiguousTargets: Array<{ target: string; candidates: T[] }> = [];
  const unmatchedTargets: string[] = [];

  for (const target of targets) {
    const candidates = sortEmailRuleCandidates(findEmailRulesByTarget(rules, target));

    if (candidates.length === 0) {
      unmatchedTargets.push(target);
      continue;
    }

    if (candidates.length === 1) {
      matchesById.set(candidates[0].id, candidates[0]);
      continue;
    }

    const activeCandidates = candidates.filter((rule) => rule.status === "active");

    if (activeCandidates.length === 1) {
      matchesById.set(activeCandidates[0].id, activeCandidates[0]);
      continue;
    }

    ambiguousTargets.push({ target, candidates });
  }

  return {
    matches: [...matchesById.values()],
    ambiguousTargets,
    unmatchedTargets
  };
}

export function sortEmailRuleCandidates<T extends Pick<EmailRuleLike, "name" | "status">>(rules: T[]): T[] {
  const statusRank = (status: string): number => {
    if (status === "active") return 0;
    if (status === "paused") return 1;
    if (status === "error") return 2;
    return 3;
  };

  return [...rules].sort((left, right) => {
    const statusDiff = statusRank(left.status) - statusRank(right.status);
    return statusDiff !== 0 ? statusDiff : left.name.localeCompare(right.name);
  });
}

export function toEmailRuleSelectionCandidate(rule: EmailRuleLike): EmailRuleSelectionCandidate {
  return {
    id: rule.id,
    name: rule.name,
    status: rule.status
  };
}

export function readEmailRuleSelectionCandidates(value: unknown): EmailRuleSelectionCandidate[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isRecord)
    .map((item) => ({
      id: typeof item.id === "string" ? item.id : "",
      name: typeof item.name === "string" ? item.name : "",
      status: typeof item.status === "string" ? item.status : ""
    }))
    .filter((item) => item.id && item.name);
}

export function selectEmailRuleCandidate(
  message: string,
  candidates: EmailRuleSelectionCandidate[]
): EmailRuleSelectionCandidate | undefined {
  const trimmed = message.trim();
  const numeric = trimmed.match(/^#?(\d+)$/);

  if (numeric) {
    const index = Number(numeric[1]) - 1;
    return candidates[index];
  }

  const ordinalIndex = ordinalSelectionIndex(trimmed);

  if (ordinalIndex !== undefined) {
    return candidates[ordinalIndex];
  }

  const key = normalizeConversationText(cleanEmailRuleTarget(trimmed) || trimmed);
  const rawKey = normalizeConversationText(trimmed);

  if (!key && !rawKey) {
    return undefined;
  }

  const prepared = candidates.map((candidate) => ({
    candidate,
    rawNameKey: normalizeConversationText(candidate.name),
    cleanNameKey: normalizeConversationText(cleanEmailRuleTarget(candidate.name) || candidate.name)
  }));
  const exactRawMatches = prepared.filter((item) => rawKey.length > 0 && item.rawNameKey === rawKey);

  if (exactRawMatches.length === 1) {
    return exactRawMatches[0].candidate;
  }

  const exactCleanMatches = prepared.filter((item) => key.length > 0 && item.cleanNameKey === key);

  if (exactCleanMatches.length === 1) {
    return exactCleanMatches[0].candidate;
  }

  const matches = prepared.filter((item) => {
    const { rawNameKey, cleanNameKey } = item;
    return (
      (rawKey.length > 0 && rawNameKey.includes(rawKey)) ||
      (key.length > 0 && cleanNameKey.includes(key))
    );
  });

  return matches.length === 1 ? matches[0].candidate : undefined;
}

function cleanSelectionKeyword(value: string): string {
  return normalizeSelectionKeywordSpelling(
    value
      .replace(/[<>"'`]/g, "")
      .replace(
        /\b(gmail|email|emails|correo|correos|mail|mails|inbox|rule|rules|regla|reglas|tracking|track|watch|monitor|please|the|my|from|about|for|project|goal|word|words|only|just|solo|solamente|nomes|nom[eé]s|unic|unica|[uú]nicament|busca|buscar|busque|busqui|mira|mirar|filtra|filtrar|palabra|palabras|paraula|paraules|clave|clau)\b/gi,
        " "
      )
      .replace(/\s+/g, " ")
      .trim()
  );
}

function normalizeSelectionKeywordSpelling(value: string): string {
  return value
    .replace(/\bbarceloa\b/gi, "Barcelona")
    .replace(/\baigues\s+(?:the\s+)?barcelona\b/gi, "Aigues de Barcelona")
    .replace(/\baigues\s+de\s+barcelona\b/gi, "Aigues de Barcelona");
}

function meaningfulRuleTokens(value: string): string[] {
  return value
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(
      (token) =>
        token.length > 2 &&
        !/^(rule|rules|regla|reglas|gmail|email|emails|correo|correos|mail|mails|tracking|new|when|will|let|know|tell|notify|notification|arrive|arrives)$/.test(token)
    );
}

function ordinalSelectionIndex(text: string): number | undefined {
  const normalized = normalizeConversationText(text);
  const map: Record<string, number> = {
    first: 0,
    "first one": 0,
    primero: 0,
    primera: 0,
    second: 1,
    "second one": 1,
    segundo: 1,
    segunda: 1,
    third: 2,
    "third one": 2,
    tercero: 2,
    tercera: 2,
    fourth: 3,
    "fourth one": 3,
    fourthone: 3,
    cuarto: 3,
    cuarta: 3,
    fifth: 4,
    "fifth one": 4,
    quinto: 4,
    quinta: 4
  };

  return map[normalized];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
