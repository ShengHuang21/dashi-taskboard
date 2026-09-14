import type { Task } from "./types";

const titleCharacters = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function shortWindowTitle(title: string) {
  return Array.from(titleCharacters.segment(title), ({ segment }) => segment).slice(0, 5).join("");
}

export function taskWindowDisplayName(task: Pick<Task, "title" | "goalWindows">) {
  const windows = task.goalWindows?.state === "declared" ? task.goalWindows.windows : [];
  return windows.length > 0 ? {
    shortTitle: windows.map(({ title }) => shortWindowTitle(title)).join(" / "),
    fullTitle: [task.title, ...windows.map(({ title }) => title)].join("\n"),
  } : { shortTitle: task.title, fullTitle: task.title };
}
