import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";

const KIB = 1024;

function finitePositive(value) {
  return Number.isFinite(value) && value > 0;
}

function roundedRatio(numerator, denominator) {
  if (!Number.isFinite(numerator) || !finitePositive(denominator)) return null;
  return Math.round((numerator / denominator) * 1_000_000) / 1_000_000;
}

export function parseMacMemoryPressure(output) {
  if (typeof output !== "string") return null;
  const totalMatch = output.match(/The system has\s+(\d+)\s*\(/i);
  const availableMatch = output.match(/System-wide memory free percentage:\s*([0-9]+(?:\.[0-9]+)?)%/i);
  const totalBytes = Number(totalMatch?.[1]);
  const availablePercent = Number(availableMatch?.[1]);
  if (!Number.isSafeInteger(totalBytes)
    || totalBytes <= 0
    || !Number.isFinite(availablePercent)
    || availablePercent < 0
    || availablePercent > 100) return null;
  const availableRatio = availablePercent / 100;
  return {
    totalBytes,
    availableBytes: Math.round(totalBytes * availableRatio),
    availableRatio,
    source: "macos-memory-pressure",
  };
}

export function parseLinuxMemoryInfo(output) {
  if (typeof output !== "string") return null;
  const values = new Map();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_()]+):\s*(\d+)\s+kB\s*$/);
    if (match) values.set(match[1], Number(match[2]) * KIB);
  }
  const totalBytes = values.get("MemTotal");
  const availableBytes = values.get("MemAvailable");
  if (!Number.isSafeInteger(totalBytes)
    || totalBytes <= 0
    || !Number.isSafeInteger(availableBytes)
    || availableBytes < 0
    || availableBytes > totalBytes) return null;
  return {
    totalBytes,
    availableBytes,
    availableRatio: roundedRatio(availableBytes, totalBytes),
    source: "linux-meminfo",
  };
}

function aggregateCpuTimes(cpus) {
  if (!Array.isArray(cpus) || cpus.length === 0) return null;
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const times = cpu?.times;
    if (!times || typeof times !== "object") return null;
    const values = [times.user, times.nice, times.sys, times.idle, times.irq];
    if (values.some((value) => !Number.isFinite(value) || value < 0)) return null;
    idle += times.idle;
    total += values.reduce((sum, value) => sum + value, 0);
  }
  return { idle, total, reportedCapacity: cpus.length };
}

function defaultMacMemoryPressure() {
  const result = spawnSync("/usr/bin/memory_pressure", ["-Q"], {
    encoding: "utf8",
    timeout: 1_000,
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout : null;
}

function readMemoryObservation({
  platform,
  readLinuxMemoryInfo,
  readMacMemoryPressure,
  readTotalMemory,
  readFreeMemory,
}) {
  try {
    if (platform === "darwin") return parseMacMemoryPressure(readMacMemoryPressure());
    if (platform === "linux") return parseLinuxMemoryInfo(readLinuxMemoryInfo());
    if (platform !== "win32") return null;
    const totalBytes = readTotalMemory();
    const availableBytes = readFreeMemory();
    if (!Number.isSafeInteger(totalBytes)
      || totalBytes <= 0
      || !Number.isSafeInteger(availableBytes)
      || availableBytes < 0
      || availableBytes > totalBytes) return null;
    return {
      totalBytes,
      availableBytes,
      availableRatio: roundedRatio(availableBytes, totalBytes),
      source: "windows-os-freemem",
    };
  } catch {
    return null;
  }
}

export function createHostResourceObserver({
  hostId = "local",
  now = Date.now,
  platform = os.platform,
  readCpuInfo = os.cpus,
  readCpuCapacity = () => os.availableParallelism?.() ?? os.cpus().length,
  readLinuxMemoryInfo = () => readFileSync("/proc/meminfo", "utf8"),
  readMacMemoryPressure = defaultMacMemoryPressure,
  readTotalMemory = os.totalmem,
  readFreeMemory = os.freemem,
  minimumSampleIntervalMs = 5_000,
} = {}) {
  let previousCpu = null;
  let cached = null;
  let cachedAtMs = null;

  return function observeHostResources() {
    const observedAtMs = now();
    if (cached
      && Number.isFinite(cachedAtMs)
      && Number.isFinite(observedAtMs)
      && observedAtMs >= cachedAtMs
      && observedAtMs - cachedAtMs < minimumSampleIntervalMs) return cached;

    const currentCpu = aggregateCpuTimes(readCpuInfo());
    const availableCapacity = Number(readCpuCapacity());
    const capacity = currentCpu && Number.isSafeInteger(availableCapacity) && availableCapacity > 0
      ? Math.min(availableCapacity, currentCpu.reportedCapacity)
      : null;
    let busyRatio = null;
    let sampleWindowMs = null;
    if (currentCpu
      && previousCpu
      && capacity === previousCpu.capacity
      && observedAtMs > previousCpu.observedAtMs) {
      const idleDelta = currentCpu.idle - previousCpu.idle;
      const totalDelta = currentCpu.total - previousCpu.total;
      if (idleDelta >= 0 && totalDelta > 0 && idleDelta <= totalDelta) {
        busyRatio = Math.round((1 - (idleDelta / totalDelta)) * 1_000_000) / 1_000_000;
        sampleWindowMs = observedAtMs - previousCpu.observedAtMs;
      }
    }
    previousCpu = currentCpu && capacity
      ? { ...currentCpu, capacity, observedAtMs }
      : null;

    const detectedPlatform = platform();
    cached = {
      schemaVersion: 1,
      source: "resident-injector",
      hostId,
      observedAt: new Date(observedAtMs).toISOString(),
      platform: detectedPlatform,
      cpu: {
        capacity,
        busyRatio,
        sampleWindowMs,
      },
      memory: readMemoryObservation({
        platform: detectedPlatform,
        readLinuxMemoryInfo,
        readMacMemoryPressure,
        readTotalMemory,
        readFreeMemory,
      }),
    };
    cachedAtMs = observedAtMs;
    return cached;
  };
}
