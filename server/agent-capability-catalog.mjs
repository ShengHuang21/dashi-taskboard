const JSON_MODE = "application/json";

const supportedCapabilities = [
  {
    id: "taskboard.task-capsule.read",
    name: "Read a recoverable task capsule",
    description: "Recover task requirements, relations, comments, inbox, handoffs, execution state, and the current safe frontier.",
    state: "supported",
    inputModes: [JSON_MODE],
    outputModes: [JSON_MODE],
    prerequisites: ["authenticated-taskboard-runtime", "existing-task"],
  },
  {
    id: "taskboard.owner-intent.capture",
    name: "Capture Owner intent",
    description: "Persist append, clarify, supersede, or cancel intent while active execution continues at its current safe boundary.",
    state: "supported",
    inputModes: [JSON_MODE],
    outputModes: [JSON_MODE],
    prerequisites: ["confirmed-owner-root", "configured-project-coordination"],
  },
  {
    id: "taskboard.work.route",
    name: "Route durable work",
    description: "Assign eligible work to a configured domain under the active Global Coordinator lease.",
    state: "supported",
    inputModes: [JSON_MODE],
    outputModes: [JSON_MODE],
    prerequisites: ["active-global-coordinator", "configured-domain"],
  },
  {
    id: "taskboard.execution.claim",
    name: "Claim bounded execution",
    description: "Grant a time-bounded task claim with an explicit write scope after admission succeeds.",
    state: "supported",
    inputModes: [JSON_MODE],
    outputModes: [JSON_MODE],
    prerequisites: ["eligible-ready-work", "valid-admission-receipt"],
  },
  {
    id: "taskboard.handoff.record",
    name: "Record a structured handoff",
    description: "Persist ordered execution handoffs and acknowledgements without transferring authorization implicitly.",
    state: "supported",
    inputModes: [JSON_MODE],
    outputModes: [JSON_MODE],
    prerequisites: ["active-task-claim"],
  },
];

const plannedCapabilities = [
  {
    id: "external.agent-card.inspect",
    name: "Inspect an external Agent Card",
    description: "Import and compare a remote agent capability declaration without dispatching work.",
    state: "planned",
    inputModes: [JSON_MODE],
    outputModes: [JSON_MODE],
    prerequisites: ["explicitly-configured-source"],
  },
  {
    id: "external.task.dispatch",
    name: "Dispatch work to an external agent",
    description: "Send approved work through a provider adapter and return durable status and artifact receipts.",
    state: "planned",
    inputModes: [JSON_MODE],
    outputModes: [JSON_MODE],
    prerequisites: ["callable-provider-adapter", "authorized-data-scope", "authorized-external-effect"],
  },
];

export function createAgentCapabilityCatalog({ version = "development" } = {}) {
  return {
    catalogVersion: 1,
    service: {
      id: "codex-taskboard",
      name: "Codex Taskboard",
      version,
    },
    protocol: {
      id: "taskboard-control-plane",
      version: 1,
      transport: "http-json",
      scope: "authenticated-local-runtime",
    },
    capabilities: [...supportedCapabilities, ...plannedCapabilities],
    interoperability: {
      a2a: {
        state: "not_implemented",
        conformant: false,
      },
      externalProviders: {
        state: "not_configured",
        inspect: false,
        dispatch: false,
        wait: false,
        checkpointReceipt: false,
      },
    },
  };
}
