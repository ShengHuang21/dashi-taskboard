import { open } from "node:fs/promises";

import { createAgentCapabilityCatalog } from "./agent-capability-catalog.mjs";

const DEFAULT_MAX_AGE_MS = 15 * 60 * 1_000;
const MAX_CARD_BYTES = 256 * 1_024;
const MAX_SKILLS = 64;
const MAX_MODES = 16;
const MAX_SECURITY_SCHEMES = 16;
const MAX_SECURITY_SCOPES = 32;
const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const PROTOCOL_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/i;

function safetyBoundary() {
  return {
    discoveryOnly: true,
    providerClaimsVerified: false,
    dispatch: false,
  };
}

function unavailableResult(state, reasonCode, { configured, observedAt = null } = {}) {
  return {
    source: {
      kind: "local_file",
      configured,
      state,
      reasonCode,
      observedAt,
    },
    card: null,
    comparison: null,
    selectable: false,
    selectionBlockers: [reasonCode, "EXTERNAL_DISPATCH_NOT_IMPLEMENTED"],
    safety: safetyBoundary(),
  };
}

function normalizedString(value, { field, maxLength = 512, pattern } = {}) {
  if (typeof value !== "string") throw new Error(`INVALID_${field}`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || (pattern && !pattern.test(normalized))) {
    throw new Error(`INVALID_${field}`);
  }
  return normalized;
}

function normalizedModes(value, field) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_MODES) {
    throw new Error(`INVALID_${field}`);
  }
  const modes = value.map((mode) => normalizedString(mode, {
    field,
    maxLength: 120,
  }).toLowerCase());
  if (new Set(modes).size !== modes.length) throw new Error(`INVALID_${field}`);
  return modes;
}

function normalizedTransport(value) {
  const transport = normalizedString(value, {
    field: "TRANSPORT",
    maxLength: 64,
  }).toLowerCase().replaceAll("_", "-");
  if (transport === "http+json" || transport === "http-json") return "http-json";
  throw new Error("UNSUPPORTED_TRANSPORT");
}

function validateCardUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("INVALID_AGENT_CARD");
  }
  const loopback = url.hostname === "localhost"
    || url.hostname === "127.0.0.1"
    || url.hostname === "[::1]";
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    || url.username || url.password) {
    throw new Error("INVALID_AGENT_CARD");
  }
}

function normalizedAuthentication(card) {
  const rawSchemes = card.securitySchemes ?? {};
  if (rawSchemes === null || typeof rawSchemes !== "object" || Array.isArray(rawSchemes)) {
    throw new Error("INVALID_AGENT_CARD");
  }
  const entries = Object.entries(rawSchemes);
  if (entries.length > MAX_SECURITY_SCHEMES) throw new Error("INVALID_AGENT_CARD");
  const schemes = new Map(entries.map(([id, value]) => {
    const normalizedId = normalizedString(id, {
      field: "SECURITY_SCHEME_ID",
      maxLength: 128,
      pattern: IDENTIFIER_PATTERN,
    });
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("INVALID_AGENT_CARD");
    }
    const type = normalizedString(value.type, {
      field: "SECURITY_SCHEME_TYPE",
      maxLength: 64,
    }).toLowerCase();
    const scheme = value.scheme === undefined
      ? null
      : normalizedString(value.scheme, {
        field: "SECURITY_SCHEME",
        maxLength: 64,
      }).toLowerCase();
    return [normalizedId, {
      id: normalizedId,
      type,
      ...(scheme === null ? {} : { scheme }),
    }];
  }));
  if (schemes.size !== entries.length) throw new Error("INVALID_AGENT_CARD");

  const rawRequirements = card.security ?? [];
  if (!Array.isArray(rawRequirements) || rawRequirements.length > MAX_SECURITY_SCHEMES) {
    throw new Error("INVALID_AGENT_CARD");
  }
  const requirements = [];
  const referencedIds = [];
  for (const requirement of rawRequirements) {
    if (requirement === null || typeof requirement !== "object" || Array.isArray(requirement)) {
      throw new Error("INVALID_AGENT_CARD");
    }
    const requirementIds = Object.keys(requirement);
    for (const id of requirementIds) {
      if (!schemes.has(id)) throw new Error("INVALID_AGENT_CARD");
      const scopes = requirement[id];
      if (!Array.isArray(scopes) || scopes.length > MAX_SECURITY_SCOPES) {
        throw new Error("INVALID_AGENT_CARD");
      }
      const normalizedScopes = scopes.map((scope) => normalizedString(scope, {
        field: "SECURITY_SCOPE",
        maxLength: 160,
      }));
      if (new Set(normalizedScopes).size !== normalizedScopes.length) {
        throw new Error("INVALID_AGENT_CARD");
      }
      if (!referencedIds.includes(id)) referencedIds.push(id);
    }
    requirements.push(requirementIds);
  }
  return {
    schemes: referencedIds.map((id) => schemes.get(id)),
    requirements,
  };
}

function normalizeAgentCard(card) {
  if (card === null || typeof card !== "object" || Array.isArray(card)) {
    throw new Error("INVALID_AGENT_CARD");
  }
  const protocolVersion = normalizedString(card.protocolVersion, {
    field: "PROTOCOL_VERSION",
    maxLength: 64,
    pattern: PROTOCOL_VERSION_PATTERN,
  });
  const name = normalizedString(card.name, { field: "NAME", maxLength: 160 });
  const description = normalizedString(card.description, {
    field: "DESCRIPTION",
    maxLength: 2_000,
  });
  validateCardUrl(card.url);
  const transport = normalizedTransport(card.preferredTransport);
  const inputModes = normalizedModes(card.defaultInputModes, "INPUT_MODES");
  const outputModes = normalizedModes(card.defaultOutputModes, "OUTPUT_MODES");
  const authentication = normalizedAuthentication(card);
  if (!Array.isArray(card.skills) || card.skills.length < 1 || card.skills.length > MAX_SKILLS) {
    throw new Error("INVALID_AGENT_CARD");
  }
  const skills = card.skills.map((skill) => {
    if (skill === null || typeof skill !== "object" || Array.isArray(skill)) {
      throw new Error("INVALID_AGENT_CARD");
    }
    return {
      id: normalizedString(skill.id, {
        field: "SKILL_ID",
        maxLength: 128,
        pattern: IDENTIFIER_PATTERN,
      }),
      name: normalizedString(skill.name, { field: "SKILL_NAME", maxLength: 160 }),
    };
  });
  if (new Set(skills.map(({ id }) => id)).size !== skills.length) {
    throw new Error("INVALID_AGENT_CARD");
  }
  return {
    protocolVersion,
    name,
    description,
    transport,
    inputModes,
    outputModes,
    authentication: authentication.schemes,
    authenticationRequirements: authentication.requirements,
    skills,
  };
}

function compareAgentCard(card) {
  const catalog = createAgentCapabilityCatalog();
  const capabilityStates = new Map(
    catalog.capabilities.map(({ id, state }) => [id, state]),
  );
  const capabilityIds = { supported: [], planned: [], unknown: [] };
  for (const { id } of card.skills) {
    const state = capabilityStates.get(id);
    if (state === "supported") capabilityIds.supported.push(id);
    else if (state === "planned") capabilityIds.planned.push(id);
    else capabilityIds.unknown.push(id);
  }
  const taskboardModes = new Set(["application/json"]);
  return {
    capabilityIds,
    transport: {
      declared: card.transport,
      taskboard: catalog.protocol.transport,
      compatible: card.transport === catalog.protocol.transport,
    },
    media: {
      input: {
        declared: [...card.inputModes],
        compatible: card.inputModes.filter((mode) => taskboardModes.has(mode)),
      },
      output: {
        declared: [...card.outputModes],
        compatible: card.outputModes.filter((mode) => taskboardModes.has(mode)),
      },
    },
    authentication: {
      requirements: card.authenticationRequirements.map((requirement) => [...requirement]),
      configured: false,
      satisfied: card.authenticationRequirements.length === 0
        || card.authenticationRequirements.some((requirement) => requirement.length === 0),
    },
  };
}

function selectionBlockers({ state, card, comparison }) {
  const blockers = [];
  if (state === "stale") blockers.push("SOURCE_STALE");
  if (!comparison.transport.compatible) blockers.push("TRANSPORT_INCOMPATIBLE");
  if (comparison.media.input.compatible.length === 0) blockers.push("INPUT_MEDIA_INCOMPATIBLE");
  if (comparison.media.output.compatible.length === 0) blockers.push("OUTPUT_MEDIA_INCOMPATIBLE");
  if (!comparison.authentication.satisfied) blockers.push("AUTHENTICATION_NOT_CONFIGURED");
  if (comparison.capabilityIds.unknown.length > 0) blockers.push("UNKNOWN_CAPABILITY_IDS");
  blockers.push("EXTERNAL_DISPATCH_NOT_IMPLEMENTED");
  return blockers;
}

export async function inspectExternalAgentCard({
  sourcePath,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  now = Date.now(),
} = {}) {
  if (!sourcePath) {
    return unavailableResult("not_configured", "SOURCE_NOT_CONFIGURED", {
      configured: false,
    });
  }

  let metadata;
  let raw;
  try {
    const handle = await open(sourcePath, "r");
    try {
      metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > MAX_CARD_BYTES) {
        return unavailableResult("unsupported", "INVALID_AGENT_CARD", {
          configured: true,
          observedAt: metadata.mtime.toISOString(),
        });
      }

      const bytes = Buffer.allocUnsafe(MAX_CARD_BYTES + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > MAX_CARD_BYTES) {
        return unavailableResult("unsupported", "INVALID_AGENT_CARD", {
          configured: true,
          observedAt: metadata.mtime.toISOString(),
        });
      }
      raw = bytes.subarray(0, offset);
    } finally {
      await handle.close();
    }
  } catch {
    return unavailableResult("unreachable", "SOURCE_UNREACHABLE", {
      configured: true,
    });
  }

  let card;
  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    card = normalizeAgentCard(JSON.parse(content));
  } catch (error) {
    const reasonCode = error?.message === "UNSUPPORTED_TRANSPORT"
      ? "UNSUPPORTED_TRANSPORT"
      : "INVALID_AGENT_CARD";
    return unavailableResult("unsupported", reasonCode, {
      configured: true,
      observedAt: metadata.mtime.toISOString(),
    });
  }

  const observedAt = metadata.mtime.toISOString();
  const state = now - metadata.mtimeMs > maxAgeMs ? "stale" : "valid";
  const comparison = compareAgentCard(card);
  const publicCard = {
    protocolVersion: card.protocolVersion,
    name: card.name,
    description: card.description,
    transport: card.transport,
    inputModes: [...card.inputModes],
    outputModes: [...card.outputModes],
    authentication: card.authentication.map((scheme) => ({ ...scheme })),
    skills: card.skills.map((skill) => ({ ...skill })),
  };
  return {
    source: {
      kind: "local_file",
      configured: true,
      state,
      reasonCode: state === "stale" ? "SOURCE_STALE" : null,
      observedAt,
    },
    card: publicCard,
    comparison,
    selectable: false,
    selectionBlockers: selectionBlockers({ state, card, comparison }),
    safety: safetyBoundary(),
  };
}
