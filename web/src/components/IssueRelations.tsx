import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type {
  GoalCoordinatorSnapshot,
  IssueRelationType,
  Task,
  TaskRelationSummary,
} from "../types";
import { taskStatusLabel, useTaskboardI18n } from "../i18n";
import type { createTaskProgressModel } from "../taskProgress";
import type { TaskCardPresentation } from "../taskConversations";
import { ActorAvatar } from "./ActorAvatar";
import { LinearIcon } from "./LinearIcon";
import { TaskProgress } from "./TaskProgress";
import { TaskExecutionStatus } from "./TaskExecutionStatus";
import type { GoalWindowMapDeclaration } from "./GoalWindowMap";
import type { CodexThreadBinding } from "../types";
import { taskDependencyGraph } from "../taskDependencyGraph";
import { listComments } from "../api";
import { latestRegisteredReviewReceipt, type RegisteredReviewReceipt } from "../registeredReview";
import {
  BlockingRelationIcon,
  PlusIcon,
  RelationIcon,
  StatusIcon,
} from "./SemanticIcons";

export interface RelationMutationResult {
  task: Task;
  relatedTask: Task;
}

export function IssuePickerContent({
  candidates,
  selectedIds,
  disabled,
  onSelect,
  onEscape,
}: {
  candidates: Task[];
  selectedIds?: ReadonlySet<string>;
  disabled?: boolean;
  onSelect: (task: Task) => void | Promise<void>;
  onEscape: () => void;
}) {
  const { text } = useTaskboardI18n();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [savingId, setSavingId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const results = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return candidates;
    return candidates.filter((task) => (
      (task.externalKey ?? task.identifier).toLocaleLowerCase().includes(normalized)
      || task.title.toLocaleLowerCase().includes(normalized)
    ));
  }, [candidates, query]);

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  useEffect(() => {
    optionRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  async function choose(task: Task) {
    setSavingId(task.id);
    try {
      await onSelect(task);
    } catch {
    } finally {
      setSavingId(null);
    }
  }

  return (
    <>
      <div className="issue-relation-search">
        <LinearIcon name="search" />
        <input
          ref={inputRef}
          value={query}
          role="combobox"
          aria-expanded="true"
          aria-controls="issue-relation-results"
          aria-activedescendant={results[activeIndex] ? `relation-option-${results[activeIndex].id}` : undefined}
          placeholder={text("搜索议题…", "Search issues…")}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Enter") {
              if (event.metaKey || event.ctrlKey) return;
              event.preventDefault();
              const activeResult = results[activeIndex];
              if (activeResult) void choose(activeResult);
            } else if (event.key === "Escape") {
              event.preventDefault();
              onEscape();
            } else if (event.key === "ArrowDown" && results.length > 0) {
              event.preventDefault();
              setActiveIndex((index) => (index + 1) % results.length);
            } else if (event.key === "ArrowUp" && results.length > 0) {
              event.preventDefault();
              setActiveIndex((index) => (index - 1 + results.length) % results.length);
            }
          }}
        />
      </div>
      <div
        className={`issue-relation-results${selectedIds ? " has-selections" : ""}`}
        id="issue-relation-results"
        role="listbox"
      >
        {results.length > 0 ? results.map((candidate, index) => {
          const selected = selectedIds?.has(candidate.id) ?? false;
          const className = [
            index === activeIndex ? "is-active" : "",
            selected ? "is-selected" : "",
          ].filter(Boolean).join(" ");
          return (
            <button
              ref={(element) => {
                optionRefs.current[index] = element;
              }}
              id={`relation-option-${candidate.id}`}
              className={className}
              type="button"
              role="option"
              aria-selected={selectedIds ? selected : index === activeIndex}
              disabled={disabled || savingId !== null}
              key={candidate.id}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => void choose(candidate)}
            >
              <StatusIcon status={candidate.status} size={14} />
              <span className="issue-relation-option-id">{candidate.externalKey ?? candidate.identifier}</span>
              <span className="issue-relation-option-title">{candidate.title}</span>
              {selectedIds && (
                <span className="issue-relation-option-check">
                  {selected && <LinearIcon name="check" />}
                </span>
              )}
            </button>
          );
        }) : (
          <p className="issue-relation-empty">{text("没有匹配的议题", "No matching issues")}</p>
        )}
      </div>
    </>
  );
}

interface RelationActions {
  task: Task;
  tasks: Task[];
  onOpenTask: (task: TaskRelationSummary) => void;
  onAddRelation: (
    task: Task,
    type: IssueRelationType,
    relatedTaskId: string,
  ) => Promise<RelationMutationResult>;
  onRemoveRelation: (
    task: Task,
    type: IssueRelationType,
    relatedTaskId: string,
  ) => Promise<RelationMutationResult>;
}

export function IssuePicker({
  label,
  candidates,
  disabled,
  onSelect,
}: {
  label: string;
  candidates: Task[];
  disabled?: boolean;
  onSelect: (task: Task) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  return (
    <div className="issue-relation-picker" ref={rootRef}>
      <button
        className="issue-relation-add"
        type="button"
        disabled={disabled}
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <PlusIcon color="currentColor" size={13} />
        <span>{label}</span>
      </button>
      {open && (
        <div className="issue-relation-popover">
          <IssuePickerContent
            candidates={candidates}
            disabled={disabled}
            onEscape={() => setOpen(false)}
            onSelect={async (task) => {
              await onSelect(task);
              setOpen(false);
            }}
          />
        </div>
      )}
    </div>
  );
}

function descendantIds(task: Task, tasks: Task[]) {
  const descendants = new Set<string>();
  const queue = [...task.relations.subIssues.map((item) => item.id)];
  const taskById = new Map(tasks.map((candidate) => [candidate.id, candidate]));
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (descendants.has(id)) continue;
    descendants.add(id);
    const child = taskById.get(id);
    if (child) queue.push(...child.relations.subIssues.map((item) => item.id));
  }
  return descendants;
}

function IssueRelationRow({
  issue,
  onOpen,
  onRemove,
  removing,
  showAssignee = false,
}: {
  issue: TaskRelationSummary;
  onOpen: () => void;
  onRemove: () => void;
  removing: boolean;
  showAssignee?: boolean;
}) {
  const { text } = useTaskboardI18n();
  return (
    <div className="issue-relation-row">
      <button className="issue-relation-target" type="button" onClick={onOpen}>
        <StatusIcon status={issue.status} size={14} />
        <span className="issue-relation-id">{issue.externalKey ?? issue.identifier}</span>
        <span className="issue-relation-title">{issue.title}</span>
        {showAssignee && <ActorAvatar actor={issue.assignee} className="issue-relation-assignee" />}
      </button>
      <button
        className="issue-relation-remove"
        type="button"
        aria-label={text(
          `移除 ${issue.externalKey ?? issue.identifier}`,
          `Remove ${issue.externalKey ?? issue.identifier}`,
        )}
        disabled={removing}
        onClick={onRemove}
      >
        <LinearIcon name="close" />
      </button>
    </div>
  );
}

export function IssueParentLink({
  task,
  tasks,
  onOpenTask,
  onAddRelation,
  onRemoveRelation,
}: RelationActions) {
  const { text } = useTaskboardI18n();
  const [saving, setSaving] = useState(false);
  const parent = task.relations.parent;
  const excluded = descendantIds(task, tasks);
  excluded.add(task.id);
  const candidates = tasks.filter((candidate) => (
    candidate.archivedAt === null
    && !excluded.has(candidate.id)
    && candidate.id !== parent?.id
  ));

  return (
    <div className={`issue-parent-link${parent ? " has-parent" : ""}`}>
      {parent && (
        <>
          <span className="issue-parent-prefix">{text("子议题属于", "Sub-issue of")}</span>
          <IssueRelationRow
            issue={parent}
            removing={saving}
            onOpen={() => onOpenTask(parent)}
            onRemove={() => {
              setSaving(true);
              void onRemoveRelation(task, "parent", parent.id)
                .catch(() => undefined)
                .finally(() => setSaving(false));
            }}
          />
        </>
      )}
      <IssuePicker
        label={parent
          ? text("更换父议题", "Change parent issue")
          : text("设置父议题", "Set parent issue")}
        candidates={candidates}
        disabled={saving}
        onSelect={async (candidate) => {
          setSaving(true);
          try {
            await onAddRelation(task, "parent", candidate.id);
          } finally {
            setSaving(false);
          }
        }}
      />
    </div>
  );
}

export function IssueSubIssues({
  task,
  tasks,
  referenceTasks,
  progressModel,
  presentations,
  adoptedInputs = [],
  goalWindowMaps = [],
  onOpenThread,
  expandedTaskIds,
  onToggleTaskExpansion,
  onOpenTask,
  onAddRelation,
  onRemoveRelation,
}: RelationActions & {
  referenceTasks: Task[];
  progressModel: ReturnType<typeof createTaskProgressModel>;
  presentations: Record<string, TaskCardPresentation>;
  adoptedInputs?: GoalCoordinatorSnapshot["adoptedInputs"];
  goalWindowMaps?: GoalWindowMapDeclaration[];
  onOpenThread: (binding: CodexThreadBinding) => void;
  expandedTaskIds: string[];
  onToggleTaskExpansion: (taskId: string) => void;
}) {
  const { language, text } = useTaskboardI18n();
  const [savingId, setSavingId] = useState<string | null>(null);
  const [collapsedTaskIds, setCollapsedTaskIds] = useState<Set<string>>(() => new Set());
  const taskById = new Map(referenceTasks.map((candidate) => [candidate.id, candidate]));
  const orderedTasks = [...taskById.values()].sort((left, right) => (
    left.createdAt.localeCompare(right.createdAt) || left.identifier.localeCompare(right.identifier)
  ));
  const childrenById = new Map(orderedTasks.map((candidate) => [
    candidate.id,
    new Map<string, TaskRelationSummary>(candidate.relations.subIssues.map((child) => [child.id, child])),
  ]));
  for (const candidate of orderedTasks) {
    const parentId = candidate.relations.parent?.id;
    if (parentId) childrenById.get(parentId)?.set(candidate.id, candidate);
  }
  const subIssues = [...(childrenById.get(task.id)?.values() ?? [])];
  const graph = taskDependencyGraph(subIssues, referenceTasks.filter((item) => item.projectId === task.projectId));
  const graphRef = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<{ key: string; path: string; partial: boolean }[]>([]);
  const [receipts, setReceipts] = useState<Record<string, RegisteredReviewReceipt | null>>({});
  const childKey = subIssues.map((item) => `${item.id}:${taskById.get(item.id)?.updatedAt ?? ""}`).join("|");
  const edgeKey = JSON.stringify(graph.edges);
  useEffect(() => {
    const controller = new AbortController();
    setReceipts({});
    void Promise.all(subIssues.map(async (item) => [item.id, latestRegisteredReviewReceipt(await listComments(item.id, controller.signal))] as const))
      .then((entries) => { if (!controller.signal.aborted) setReceipts(Object.fromEntries(entries)); })
      .catch(() => { /* Missing evidence remains unknown; no mutation or retry. */ });
    return () => controller.abort();
  }, [task.id, childKey]);
  useEffect(() => {
    const element = graphRef.current;
    if (!element) return;
    const measure = () => {
      const bounds = element.getBoundingClientRect();
      const cards = new Map([...element.querySelectorAll<HTMLElement>("[data-task-id]")].map((card) => [card.dataset.taskId, card.getBoundingClientRect()]));
      const next = graph.edges.flatMap((edge) => {
        // Partial leaf dependencies are listed explicitly, not drawn as stage gates.
        if (edge.partial) return [];
        const a = cards.get(edge.from), b = cards.get(edge.to);
        if (!a || !b) return [];
        const x1 = a.left + a.width / 2 - bounds.left, x2 = b.left + b.width / 2 - bounds.left;
        const y1 = a.bottom - bounds.top, y2 = b.top - bounds.top;
        const mid = y2 > y1 ? (y1 + y2) / 2 : Math.max(y1, b.bottom - bounds.top) + 24;
        return [{ key: `${edge.from}:${edge.to}`, path: `M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}`, partial: edge.partial }];
      });
      setLines((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    element.querySelectorAll("[data-task-id]").forEach((card) => observer.observe(card));
    measure();
    return () => observer.disconnect();
  }, [task.id, childKey, edgeKey, goalWindowMaps]);
  const directIds = new Set(subIssues.map((issue) => issue.id));
  const ancestors = new Set<string>([task.id]);
  let parent = task.relations.parent;
  while (parent && !ancestors.has(parent.id)) {
    ancestors.add(parent.id);
    parent = taskById.get(parent.id)?.relations.parent ?? null;
  }
  const candidates = tasks.filter((candidate) => (
    candidate.archivedAt === null
    && !ancestors.has(candidate.id)
    && !directIds.has(candidate.id)
  ));

  function groupedChildren(children: Iterable<TaskRelationSummary>) {
    const planGroups = new Map<number, Map<string, TaskRelationSummary[]>>();
    const unplanned: TaskRelationSummary[] = [];
    for (const issue of children) {
      const child = taskById.get(issue.id);
      const groupLabel = child?.labels.find((label) => /^plan-group\s*[:=-]?\s*\d+$/i.test(label.trim()));
      const group = groupLabel ? Number(groupLabel.match(/\d+/)?.[0]) : Number.NaN;
      if (!Number.isFinite(group)) {
        unplanned.push(issue);
        continue;
      }
      const laneLabel = child?.labels.find((label) => /^plan-lane\s*[:=-]?\s*.+$/i.test(label.trim()));
      const lane = laneLabel?.replace(/^plan-lane\s*[:=-]?\s*/i, "").trim() || text("未分泳道", "Unassigned lane");
      const lanes = planGroups.get(group) ?? new Map<string, TaskRelationSummary[]>();
      lanes.set(lane, [...(lanes.get(lane) ?? []), issue]);
      planGroups.set(group, lanes);
    }
    return { planGroups, unplanned };
  }

  function renderChildren(parentId: string, path: ReadonlySet<string>, children?: Iterable<TaskRelationSummary>): ReactNode {
    return [...(children ?? childrenById.get(parentId)?.values() ?? [])]
      .filter((relation) => !path.has(relation.id))
      .map((relation) => {
        const child = taskById.get(relation.id);
        const issue = child ?? relation;
        const childPath = new Set([...path, issue.id]);
        const hasChildren = [...(childrenById.get(issue.id)?.keys() ?? [])]
          .some((id) => !childPath.has(id));
        const expanded = !collapsedTaskIds.has(issue.id);
        const execution = presentations[issue.id]?.execution ?? "uncertain";
        const responsibleWindows = goalWindowMaps.flatMap((declaration) => declaration.nodes.filter((node) => node.issueRefs?.some((reference) => (
          (reference.role === "owned" || reference.role === "current")
          && reference.taskId === issue.id
          && reference.identifier === (issue.externalKey ?? issue.identifier)
        ))).map((node) => ({ declaration, node })));
        const reviewers = (declaration: GoalWindowMapDeclaration, ownerId: string) => declaration.edges.filter((edge) => edge.kind === "review" && edge.from === ownerId)
          .map((edge) => declaration.nodes.find((node) => node.id === edge.to))
          .filter((node): node is NonNullable<typeof node> => Boolean(node));
        const unfinishedPrerequisites = child?.relations.blockedBy.filter((dependency) => dependency.status !== "done") ?? [];
        const inputsAdopted = execution === "dependency" && unfinishedPrerequisites.length > 0
          && unfinishedPrerequisites.every((dependency) => adoptedInputs.some((input) => (
            input.consumerTaskId === issue.id && input.producerTaskId === dependency.id
          )));
        return (
          <li className="issue-tree-node" data-task-id={issue.id} key={issue.id}>
            <div className="issue-tree-row">
              <div className="issue-tree-content">
                <button
                  className="issue-tree-target"
                  type="button"
                  aria-label={text(`打开 ${issue.title} 详情`, `Open details for ${issue.title}`)}
                  disabled={!child}
                  onClick={() => onOpenTask(issue)}
                >
                  <StatusIcon status={issue.status} size={14} />
                  <span className="issue-relation-id">{issue.externalKey ?? issue.identifier}</span>
                  <span className="issue-tree-title">{issue.title}</span>
                  <ActorAvatar actor={issue.assignee} className="issue-relation-assignee" />
                </button>
                <div className="issue-tree-status">
                  <span>{taskStatusLabel(language, issue.status)}</span>
                  {responsibleWindows.map(({ declaration, node: window }) => <details className="issue-tree-window" key={`${declaration.sourceCommentId}:${window.id}`}>
                    <summary>{text("负责窗口", "Responsible window")} · {window.roleLabel}</summary>
                    <p>{window.title}</p><p>{text("职责", "Scope")} · {window.scope}</p><p>{text("记录状态", "Recorded state")} · {window.recordedState}</p><p>{declaration.sourceCommentId} · v{declaration.sourceCommentVersion}</p>
                    {window.threadBinding ? <button className="button secondary" type="button" onClick={() => onOpenThread(window.threadBinding!)}>{text("打开窗口", "Open window")}</button> : <p>{text("窗口绑定未登记", "Window binding not recorded")}</p>}
                    {reviewers(declaration, window.id).map((reviewer) => <details key={reviewer.id}><summary>{text("独立审查 sub-agent", "Independent review sub-agent")} · {reviewer.roleLabel}</summary><p>{reviewer.title}</p><p>{reviewer.recordedState}</p>{reviewer.threadBinding ? <button className="button secondary" type="button" onClick={() => onOpenThread(reviewer.threadBinding!)}>{text("打开窗口", "Open window")}</button> : <p>{text("窗口绑定未登记", "Window binding not recorded")}</p>}</details>)}
                  </details>)}
                  {inputsAdopted ? <span data-execution-state="artifact_input">
                    {text("前置产物输入已采用", "Prerequisite artifact input adopted")}
                  </span> : <TaskExecutionStatus state={execution} />}
                  {child?.archivedAt ? <span>{text("已归档 · 归档不等于完成", "Archived · archiving does not mean completion")}</span> : null}
                </div>
                <TaskProgress
                  progress={progressModel.forTask(issue.id)}
                  label={text(`${issue.title}的进度`, `Progress for ${issue.title}`)}
                  showStages
                  leafStatus={!hasChildren ? issue.status : undefined}
                  reviewReceipt={receipts[issue.id] ?? null}
                />
                <p className="dependency-card-summary">{text("方法 / 产物", "Method / output")} · {child?.description.split("\n").map((line) => line.trim()).find((line) => line && !line.startsWith("#") && !line.startsWith("```"))?.replace(/^[\s>*-]+/, "").slice(0, 110) || text("未记录", "Not recorded")}</p>
                <p className="dependency-card-model">{text("实际模型（登记）", "Actual model (recorded)")} · {receipts[issue.id]?.implementation?.threadId === child?.threadBinding?.threadId && receipts[issue.id]?.implementation
                  ? `${receipts[issue.id]!.implementation!.model} / ${receipts[issue.id]!.implementation!.reasoningEffort}`
                  : text("未知", "Unknown")}</p>
              </div>
              {parentId === task.id && child ? (
                <button
                  className="issue-tree-remove"
                  type="button"
                  aria-label={text(
                    `移除 ${issue.externalKey ?? issue.identifier}`,
                    `Remove ${issue.externalKey ?? issue.identifier}`,
                  )}
                  disabled={savingId === issue.id}
                  onClick={() => {
                    setSavingId(issue.id);
                    void onRemoveRelation(child, "parent", task.id)
                      .catch(() => undefined)
                      .finally(() => setSavingId(null));
                  }}
                >
                  <LinearIcon name="close" />
                </button>
              ) : null}
            </div>
            {hasChildren ? <p className="issue-tree-next-level">{text("打开此任务查看下一层依赖图", "Open this task for the next dependency graph level")}</p> : null}
          </li>
        );
      });
  }

  function renderChildLayout(parentId: string, path: ReadonlySet<string>, children?: Iterable<TaskRelationSummary>): ReactNode {
    const childIssues = [...(children ?? childrenById.get(parentId)?.values() ?? [])]
      .filter((relation) => !path.has(relation.id));
    const { planGroups, unplanned } = groupedChildren(childIssues);
    if (planGroups.size === 0) return renderChildren(parentId, path, childIssues);

    return (
      <>
        {[...planGroups.entries()].sort(([left], [right]) => left - right).map(([group, lanes]) => (
          <li className="issue-tree-plan-group" key={group}>
            <section className="plan-group" aria-label={text(`计划组 ${String(group).padStart(2, "0")}`, `Plan group ${String(group).padStart(2, "0")}`)}>
              <h3>{text(`计划组 ${String(group).padStart(2, "0")}`, `Plan group ${String(group).padStart(2, "0")}`)}</h3>
              <div className="plan-group-lanes">
                {[...lanes.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([lane, issues]) => (
                  <section className="plan-lane" key={lane} aria-label={text(`泳道 ${lane}`, `Lane ${lane}`)}>
                    <h4>{lane}</h4>
                    <ul className="issue-tree-children">{renderChildren(parentId, path, issues)}</ul>
                  </section>
                ))}
              </div>
            </section>
          </li>
        ))}
        {unplanned.length > 0 ? renderChildren(parentId, path, unplanned) : null}
      </>
    );
  }

  function dependencyLayers(issues: TaskRelationSummary[]) {
    const ids = new Set(issues.map((issue) => issue.id));
    const depth = new Map(issues.map((issue) => [issue.id, 0]));
    const incoming = new Map(issues.map((issue) => [issue.id, 0]));
    const outgoing = new Map<string, string[]>();
    for (const issue of issues) for (const dependency of taskById.get(issue.id)?.relations.blockedBy ?? []) {
      if (!ids.has(dependency.id)) continue;
      incoming.set(issue.id, (incoming.get(issue.id) ?? 0) + 1);
      outgoing.set(dependency.id, [...(outgoing.get(dependency.id) ?? []), issue.id]);
    }
    const ready = issues.filter((issue) => incoming.get(issue.id) === 0);
    while (ready.length) { const issue = ready.shift()!; for (const target of outgoing.get(issue.id) ?? []) { depth.set(target, Math.max(depth.get(target) ?? 0, (depth.get(issue.id) ?? 0) + 1)); const left = (incoming.get(target) ?? 0) - 1; incoming.set(target, left); if (!left) ready.push(issues.find((item) => item.id === target)!); } }
    return [...depth.entries()].reduce<Map<number, TaskRelationSummary[]>>((layers, [id, layer]) => { layers.set(layer, [...(layers.get(layer) ?? []), issues.find((issue) => issue.id === id)!]); return layers; }, new Map());
  }

  return (
    <section className="issue-sub-issues" aria-labelledby="sub-issues-heading">
      <header>
        <div>
          <h2 id="sub-issues-heading">{text("任务依赖图", "Task dependency graph")}</h2>
          {subIssues.length > 0 && (
            <span className="sub-issue-summary">
              {text(`${subIssues.length} 个直接子议题`, `${subIssues.length} direct sub-issues`)}
            </span>
          )}
        </div>
        <IssuePicker
          label={text("添加子议题", "Add sub-issue")}
          candidates={candidates}
          disabled={savingId !== null}
          onSelect={async (candidate) => {
            setSavingId(candidate.id);
            try {
              await onAddRelation(candidate, "parent", task.id);
            } finally {
              setSavingId(null);
            }
          }}
        />
      </header>
      {subIssues.length > 0 && (
        <div>
          <p className="dependency-legend">{text("实线箭头＝整张卡的前置依赖。并排阶段可交叠推进；其中部分任务仍需等待具体前置，见下方依赖说明。排列不代表启动授权。点击卡片查看下一层。", "Solid arrows: whole-card prerequisites. Side-by-side stages may overlap; individual tasks still wait for the exact inputs listed below. Layout is not start authorization. Open a card to drill down.")}</p>
          {graph.crossed && <p>{text("此层存在交叉局部依赖；请按下方具体任务关系下钻。", "Crossed dependencies at this level; inspect the exact task links below.")}</p>}
          {graph.edges.some((edge) => edge.partial) && <p className="dependency-legend"><strong>{text("部分任务依赖，可交叠推进", "Partial task dependencies; stages may overlap")}</strong> · {text("无需等待整个前一阶段完成；具体前置见图下方。横向滚动查看同层任务。", "No whole-stage completion gate; exact prerequisites are listed below. Scroll horizontally for same-level tasks.")}</p>}
          <div ref={graphRef} className="issue-sub-issue-list issue-tree dependency-graph">
            <svg className="dependency-edges" aria-hidden="true"><defs><marker id="task-dependency-head" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8" fill="var(--accent)" /></marker></defs>{lines.map((line) => <path key={line.key} d={line.path} fill="none" stroke="var(--accent)" strokeWidth="2" strokeDasharray={line.partial ? "6 4" : undefined} markerEnd="url(#task-dependency-head)" />)}</svg>
            {graph.layers.map(([layer, issues]) => <section className="dependency-layer" key={layer}><ul className="issue-tree-children">{renderChildren(task.id, new Set([task.id]), issues)}</ul></section>)}
          </div>
          <ul className="dependency-evidence">{graph.edges.map((edge) => <li key={`${edge.from}:${edge.to}`}><strong>{edge.partial ? text("部分任务依赖，可交叠推进", "Partial task dependency; stages may overlap") : text("前置依赖", "Prerequisite")}</strong> · {subIssues.find((issue) => issue.id === edge.from)?.title} → {subIssues.find((issue) => issue.id === edge.to)?.title}<br />{edge.evidence.map((pair) => `${pair.from} → ${pair.to}`).join(" · ")}</li>)}{graph.external.map((edge, index) => <li key={`external:${index}`}>{text("本层外的前置", "Prerequisite outside this view")} · {edge.prerequisite} → {edge.task}</li>)}</ul>
        </div>
      )}
    </section>
  );
}

const RELATION_GROUPS = [
  { type: "blocked_by", field: "blockedBy", chineseLabel: "阻塞于", englishLabel: "Blocked by", chineseAddLabel: "添加阻塞议题", englishAddLabel: "Add blocker", tone: "blocked-by" },
  { type: "blocks", field: "blocks", chineseLabel: "阻塞", englishLabel: "Blocks", chineseAddLabel: "添加被阻塞议题", englishAddLabel: "Add blocked issue", tone: "blocks" },
  { type: "related", field: "related", chineseLabel: "相关议题", englishLabel: "Related issues", chineseAddLabel: "添加相关议题", englishAddLabel: "Add related issue", tone: "related" },
] as const;

export function IssueRelationSidebar({
  task,
  tasks,
  onOpenTask,
  onAddRelation,
  onRemoveRelation,
}: RelationActions) {
  const { text } = useTaskboardI18n();
  const [savingKey, setSavingKey] = useState<string | null>(null);

  return (
    <section className="issue-relation-sidebar" aria-labelledby="relations-heading">
      <h2 id="relations-heading">{text("关系", "Relations")}</h2>
      {RELATION_GROUPS.map((group) => {
        const label = text(group.chineseLabel, group.englishLabel);
        const issues = task.relations[group.field];
        const existing = new Set(issues.map((issue) => issue.id));
        const candidates = tasks.filter((candidate) => (
          candidate.archivedAt === null
          && candidate.id !== task.id
          && !existing.has(candidate.id)
        ));
        return (
          <div className={`issue-relation-group is-${group.tone}`} key={group.type}>
            <header>
              <span>
                {group.type === "related" ? (
                  <RelationIcon color="currentColor" size={14} />
                ) : (
                  <BlockingRelationIcon type={group.type} color="currentColor" />
                )}
                {label}
              </span>
              <IssuePicker
                label={text(group.chineseAddLabel, group.englishAddLabel)}
                candidates={candidates}
                disabled={savingKey !== null}
                onSelect={async (candidate) => {
                  const key = `${group.type}:${candidate.id}`;
                  setSavingKey(key);
                  try {
                    await onAddRelation(task, group.type, candidate.id);
                  } finally {
                    setSavingKey(null);
                  }
                }}
              />
            </header>
            {issues.map((issue) => (
              <IssueRelationRow
                issue={issue}
                key={issue.id}
                removing={savingKey === `${group.type}:${issue.id}`}
                onOpen={() => onOpenTask(issue)}
                onRemove={() => {
                  const key = `${group.type}:${issue.id}`;
                  setSavingKey(key);
                  void onRemoveRelation(task, group.type, issue.id)
                    .catch(() => undefined)
                    .finally(() => setSavingKey(null));
                }}
              />
            ))}
          </div>
        );
      })}
    </section>
  );
}
