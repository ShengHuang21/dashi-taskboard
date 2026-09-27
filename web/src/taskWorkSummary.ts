import type { Task, TaskChangeActivity } from "./types";

export interface WorkExcerpt {
  heading: string;
  text: string;
  line: number;
}

// Only explicit headings/fields in the current description are projected.
// Comments and window declarations cannot replace this task-local source.
export function projectTaskWork(task: Pick<Task, "id" | "description" | "version" | "updatedAt">) {
  const lines = task.description.split("\n");
  const sections: WorkExcerpt[] = [];
  const fieldLines: { text: string; line: number }[] = [];
  let section: WorkExcerpt = { heading: "", text: "", line: 1 };
  let fence: string | null = null;
  let historyLine: number | null = null;
  for (const [index, line] of lines.entries()) {
    const marker = line.trim().match(/^(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1][0];
      else if (marker[1][0] === fence) fence = null;
      section.text += `${line}\n`;
      continue;
    }
    if (!fence && /下方为历史|历史范围和原验收保留|^\s*#{1,6}\s+历史(?:连续性|背景|记录|方案|计划)/.test(line)) {
      historyLine = index + 1;
      break;
    }
    const heading = !fence ? line.match(/^\s*#{1,6}\s+(.+?)\s*#*\s*$/) : null;
    if (heading) {
      sections.push({ ...section, text: section.text.trim() });
      section = { heading: heading[1], text: "", line: index + 1 };
    } else {
      section.text += `${line}\n`;
      if (!fence && line.trim()) fieldLines.push({ text: line.trim(), line: index + 1 });
    }
  }
  sections.push({ ...section, text: section.text.trim() });
  const findSection = (pattern: RegExp) => sections.find((item) => pattern.test(item.heading));
  const findField = (pattern: RegExp, includeParagraph = false) => {
    const match = fieldLines.find((item) => pattern.test(item.text.replace(/^[\s>*-]+/, "").replace(/\*\*/g, "")));
    if (!match) return undefined;
    const paragraph = [match.text];
    if (includeParagraph) {
      for (let index = match.line; index < (historyLine ? historyLine - 1 : lines.length); index += 1) {
        const line = lines[index];
        if (!line.trim() || /^\s*(?:#{1,6}\s|`{3,}|~{3,})/.test(line)) break;
        paragraph.push(line);
      }
    }
    return { heading: "", text: paragraph.join("\n"), line: match.line };
  };
  return {
    source: { taskId: task.id, version: task.version, updatedAt: task.updatedAt },
    historyLine,
    sections,
    current: findField(/^(?:当前\s*blocked|当前等待|当前受阻|(?:Currently\s+)?blocked|waiting)\s*[:：]/i, true)
      ?? findSection(/^(?:当前执行状态|当前固定候选|当前范围与状态|当前任务|当前状态|当前工作|Current (?:status|task|work))/i),
    next: findField(/^(?:下一步|下一顺序|Next step)\s*[:：]/i)
      ?? findSection(/^(?:下一步|下一顺序|Next steps?)(?:\s*[:：]|\s*$)/i),
    handoff: findSection(/^(?:QA\s*领取与交回|后续验证与交接)/i),
    scope: findSection(/^(?:本范围职责|职责|当前范围与状态|固定输入与唯一写范围|Scope|Responsibilities)/i),
    input: findField(/^Input\s*[:：]/i) ?? findSection(/^(?:Input(?:\s*\/\s*Output)?|输入|固定输入)/i),
    output: findField(/^Output\s*[:：]/i) ?? findSection(/^(?:Output|输出|实际产出)/i),
    evidence: findSection(/^(?:固定证据|验收证据|验证证据|测试证据|Evidence)/i),
  };
}

export function taskDescriptionHistory(taskId: string, activities: TaskChangeActivity[]) {
  return activities.filter((activity) => activity.taskId === taskId)
    .flatMap((activity) => activity.changes.flatMap((change, index) => {
      if (change.field !== "description" || typeof change.before !== "string" || typeof change.after !== "string") return [];
      const source = { id: taskId, version: 0, updatedAt: activity.createdAt };
      const before = projectTaskWork({ ...source, description: change.before });
      const after = projectTaskWork({ ...source, description: change.after });
      const headings = [...new Set([...before.sections, ...after.sections].map((section) => section.heading))]
        .filter((heading) => JSON.stringify(before.sections.filter((section) => section.heading === heading).map((section) => section.text))
          !== JSON.stringify(after.sections.filter((section) => section.heading === heading).map((section) => section.text)));
      return [{ id: `${activity.id}:${index}`, activityId: activity.id, actorName: activity.actorName,
        createdAt: activity.createdAt, headings, before: change.before, after: change.after }];
    })).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function compactWorkExcerpt(excerpt: WorkExcerpt | undefined, limit = 110) {
  if (!excerpt) return null;
  const value = (/[:：]/.test(excerpt.heading) ? excerpt.heading : excerpt.text || excerpt.heading)
    .replace(/\s+/g, " ").trim();
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}
