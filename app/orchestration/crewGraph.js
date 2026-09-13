const CREW_NODE = Object.freeze({
  RESEARCH: "research",
  STRATEGIST: "content-strategist",
  WRITER: "copywriter",
  REVIEWER: "content-reviewer",
  HUMAN_APPROVAL: "human-approval",
});

const DEFAULT_CONTENT_CREW_GRAPH = Object.freeze([
  Object.freeze({
    id: CREW_NODE.RESEARCH,
    role: "Research Agent",
    kind: "input",
    dependsOn: Object.freeze([]),
    externalMutation: false,
  }),
  Object.freeze({
    id: CREW_NODE.STRATEGIST,
    role: "Content Strategist",
    kind: "agent",
    dependsOn: Object.freeze([CREW_NODE.RESEARCH]),
    externalMutation: false,
  }),
  Object.freeze({
    id: CREW_NODE.WRITER,
    role: "Copywriter",
    kind: "agent",
    dependsOn: Object.freeze([CREW_NODE.STRATEGIST]),
    externalMutation: false,
  }),
  Object.freeze({
    id: CREW_NODE.REVIEWER,
    role: "Content Reviewer",
    kind: "agent",
    dependsOn: Object.freeze([CREW_NODE.WRITER]),
    externalMutation: false,
  }),
  Object.freeze({
    id: CREW_NODE.HUMAN_APPROVAL,
    role: "Human Approval",
    kind: "hard-gate",
    dependsOn: Object.freeze([CREW_NODE.REVIEWER]),
    externalMutation: false,
    autonomous: false,
  }),
]);

function validateCrewGraph(graph = DEFAULT_CONTENT_CREW_GRAPH) {
  if (!Array.isArray(graph) || graph.length === 0) throw new Error("Crew graph must contain nodes");
  const ids = new Set();
  for (const node of graph) {
    if (!node?.id || typeof node.id !== "string") throw new Error("Crew node id is required");
    if (ids.has(node.id)) throw new Error(`Duplicate crew node: ${node.id}`);
    ids.add(node.id);
    if (node.externalMutation === true) throw new Error(`Crew node cannot own external mutation: ${node.id}`);
  }
  for (const node of graph) {
    for (const dependency of node.dependsOn || []) {
      if (!ids.has(dependency)) throw new Error(`Unknown crew dependency: ${dependency}`);
      if (dependency === node.id) throw new Error(`Crew node cannot depend on itself: ${node.id}`);
    }
  }
  const approval = graph.find(node => node.id === CREW_NODE.HUMAN_APPROVAL);
  if (!approval || approval.kind !== "hard-gate" || approval.autonomous !== false) {
    throw new Error("Crew graph requires a non-autonomous human approval hard gate");
  }
  return true;
}

function publicCrewGraph(graph = DEFAULT_CONTENT_CREW_GRAPH) {
  validateCrewGraph(graph);
  return graph.map(node => ({
    id: node.id,
    role: node.role,
    kind: node.kind,
    dependsOn: [...(node.dependsOn || [])],
    externalMutation: Boolean(node.externalMutation),
    autonomous: node.autonomous !== false,
  }));
}

module.exports = {
  CREW_NODE,
  DEFAULT_CONTENT_CREW_GRAPH,
  validateCrewGraph,
  publicCrewGraph,
};
