#!/usr/bin/env python3
"""Local app-server transport supervisor. No tracker credentials or issue tools in the child.

The scheduler claims first and supplies one immutable snapshot. launch.guard is
never removed. Recovery observes/replays an existing attempt; it cannot launch.
"""
import hashlib
import json
import os
import pathlib
import re
import selectors
import signal
import subprocess
import sys
import time


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def read_json(filename):
    return json.loads(pathlib.Path(filename).read_text())


def save(filename, value, immutable=False):
    data = (canonical(value) + "\n").encode()
    filename = pathlib.Path(filename)
    if immutable:
        try:
            fd = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            if read_json(filename) != value:
                raise RuntimeError("immutable attempt payload changed")
            return
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    else:
        temporary = filename.with_suffix(filename.suffix + ".tmp")
        with open(temporary, "wb") as stream:
            os.chmod(temporary, 0o600)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, filename)


def processes():
    raw = subprocess.check_output(["/bin/ps", "-axo", "pid=,ppid=,pgid=,lstart="], text=True)
    result = {}
    for line in raw.splitlines():
        fields = line.split(None, 3)
        if len(fields) == 4:
            result[int(fields[0])] = {"pid": int(fields[0]), "ppid": int(fields[1]),
                                      "pgid": int(fields[2]), "birth": fields[3]}
    return result


def same_process(table, record):
    return table.get(record["pid"], {}).get("birth") == record["birth"]


def validate_snapshot(snapshot):
    release = snapshot["release"]
    execution = release["execution"]
    if digest(canonical(execution).encode()) != release["executionHash"]:
        raise RuntimeError("execution hash mismatch")
    cwd = pathlib.Path(execution["workspace"]["path"])
    if str(cwd.resolve(strict=True)) != str(cwd) or not cwd.is_dir():
        raise RuntimeError("frozen workspace changed")
    for item in execution["inputs"]:
        source = pathlib.Path(item["path"])
        if str(source.resolve(strict=True)) != str(source) or source.stat().st_mode & 0o222:
            raise RuntimeError("input snapshot is no longer immutable")
        if digest(source.read_bytes()) != item["sha256"]:
            raise RuntimeError("input hash mismatch")
    capability = read_json(snapshot["capabilityFile"])
    binary = capability["entry"][0]
    if digest(pathlib.Path(binary).read_bytes()) != capability["binary_sha256"]:
        raise RuntimeError("capability executable changed")
    models = capability["result"]["models"]
    supported = any(model["model"] == execution["model"] and any(
        effort["reasoningEffort"] == execution["effort"] for effort in model["supportedReasoningEfforts"])
        for model in models)
    if not supported:
        raise RuntimeError("unsupported model/effort for the actual executable")
    if execution["git"] is not None:
        baseline = execution["git"]
        def git(*args):
            return subprocess.check_output(["git", "-C", str(cwd), *args], text=True).strip()
        def repository(value):
            return value.removeprefix("https://github.com/").removeprefix("git@github.com:").removesuffix(".git")
        if git("rev-parse", "HEAD") != baseline["baseCommit"] or git("branch", "--show-current") != baseline["branch"] or repository(git("remote", "get-url", "origin")) != repository(baseline["repository"]):
            raise RuntimeError("Git baseline changed")
    return execution, binary, capability


DISABLED_FEATURES = tuple("plugins remote_plugin apps browser_use browser_use_external in_app_browser computer_use hooks multi_agent skill_mcp_dependency_install image_generation view_image code_mode artifact in_app_chat in_app_local_automation memories skill_search worktrees workspace_dependencies realtime_conversation tool_suggest standalone_web_search daemon_auto_start goals shell_snapshot multi_agent_v2".split())
PROFILE_ID = "taskboard_local"


def toml(value):
    if isinstance(value, dict):
        return "{" + ", ".join(json.dumps(key) + "=" + toml(item) for key, item in value.items()) + "}"
    return json.dumps(value)


def without_nulls(value):
    # config/read serializes absent optional profile settings as null.
    if isinstance(value, dict):
        return {key: without_nulls(item) for key, item in value.items() if item is not None}
    return value


def local_arguments(snapshot, execution, binary, environment):
    """Freeze one process's permissions; reuse login without copying its secrets.

    The app-server/controller is trusted. Its model-invoked local tools consume
    this profile. MCP/plugins/browser/web/agents are separately disabled.
    """
    def existing(value):
        source = pathlib.Path(value)
        if not source.is_absolute():
            raise RuntimeError("protection paths must be absolute")
        return source.resolve(strict=True)

    protection = snapshot["protection"]
    workspace = existing(execution["workspace"]["path"])
    inputs = existing(protection["inputRoot"])
    codex_home = existing(environment.get("CODEX_HOME", str(pathlib.Path.home() / ".codex")))
    denied = sorted(set(existing(value) for value in protection["deniedPaths"]) | {codex_home})
    if not denied or workspace.is_relative_to(inputs) or inputs.is_relative_to(workspace):
        raise RuntimeError("invalid input and workspace separation")
    for private in denied:
        if any(allowed.is_relative_to(private) or private.is_relative_to(allowed) for allowed in (workspace, inputs)):
            raise RuntimeError("private paths overlap worker/input scope")
    if any(not existing(item["path"]).is_relative_to(inputs) for item in execution["inputs"]):
        raise RuntimeError("input is outside the frozen input root")
    filesystem = {":root": "read", ":tmpdir": "read", ":slash_tmp": "read", str(workspace): "write", str(inputs): "read"}
    filesystem.update({str(value): "deny" for value in denied})
    profile = {"extends": ":workspace", "filesystem": filesystem,
               "network": {"enabled": execution["authority"]["network"] == "authorized-git"}}
    args = [binary, "-c", "model=" + json.dumps(execution["model"]),
            "-c", "model_reasoning_effort=" + json.dumps(execution["effort"]),
            "-c", "permissions." + PROFILE_ID + "=" + toml(profile),
            "-c", "default_permissions=" + json.dumps(PROFILE_ID),
            "-c", 'web_search="disabled"', "-c", "mcp_servers={}",
            "-c", "features.code_mode_host=true"]
    for feature in DISABLED_FEATURES:
        args += ["-c", "features." + feature + "=false"]

    def inventory(command):
        # Metadata only: discard server URLs, environment and header values. They
        # must never be included in evidence, errors, the snapshot or the prompt.
        result = subprocess.run(command + ["mcp", "list", "--json"], cwd=workspace,
                                env=environment, capture_output=True, timeout=20, check=False)
        if result.returncode != 0:
            raise RuntimeError("MCP configuration inventory unavailable")
        records = json.loads(result.stdout)
        if not isinstance(records, list) or any(not isinstance(item.get("name"), str) or not isinstance(item.get("enabled"), bool) for item in records):
            raise RuntimeError("MCP configuration inventory unsupported")
        return [{"name": item["name"], "enabled": item["enabled"]} for item in records]

    inherited = inventory(args)
    for item in inherited:
        if not re.fullmatch(r"[A-Za-z0-9_-]+", item["name"]):
            raise RuntimeError("MCP configuration name cannot be safely overridden")
        args += ["-c", "mcp_servers." + item["name"] + ".enabled=false"]
    effective = inventory(args)
    if {item["name"] for item in inherited} != {item["name"] for item in effective} or any(item["enabled"] for item in effective):
        raise RuntimeError("MCP configuration could not be disabled")
    return args + ["app-server", "--listen", "stdio://"], {"profileId": PROFILE_ID, "profile": profile,
        "inheritedMcp": inherited, "effectiveMcp": effective, "disabledFeatures": list(DISABLED_FEATURES),
        "requiredFeatures": {"code_mode_host": True}, "webSearch": "disabled"}


class Supervisor:
    def __init__(self, directory):
        self.directory = pathlib.Path(directory).resolve(strict=True)
        self.snapshot = read_json(self.directory / "snapshot.json")
        self.execution = self.snapshot["release"]["execution"]
        self.child = None
        self.known = {}
        self.identity_uncertain = False
        self.identity = {"wrapperPid": os.getpid(), "childPid": None, "processGroupId": None,
                         "birth": processes()[os.getpid()]["birth"]}
        self.observed = {"model": None, "effort": None}
        self.thread_id = None
        self.session_id = None
        self.final_text = None
        self.stop_reason = "parent transport closed"
        self.stopping = False
        self.response_ids = {}
        self.permissions = None

    def remember(self):
        table = processes()
        self.identity_uncertain |= any(record["pid"] in table and not same_process(table, record) for record in self.known.values())
        if self.child:
            # Popen owns an unreaped direct child. Capture its identity once;
            # neither a historical PID nor its reused group establishes ownership.
            entry = table.get(self.child.pid, {})
            if self.child.pid not in self.known and self.child.returncode is None:
                if entry.get("ppid") == os.getpid() and entry.get("pgid") == self.child.pid:
                    self.known[self.child.pid] = {"pid": self.child.pid, "birth": entry["birth"]}
                else:
                    self.identity_uncertain = True
            selected = {pid for pid, record in self.known.items() if same_process(table, record)}
            owned_group = self.child.pid in selected
            changed = True
            while changed:
                changed = False
                for pid, entry in table.items():
                    if pid in self.known and not same_process(table, self.known[pid]):
                        continue
                    if entry["ppid"] in selected or (owned_group and entry["pgid"] == self.child.pid):
                        if pid not in selected:
                            selected.add(pid)
                            changed = True
            for pid in selected:
                if pid in table and pid not in self.known:
                    self.known[pid] = {"pid": pid, "birth": table[pid]["birth"]}
        save(self.directory / "process.json", {"process": self.identity, "descendants": list(self.known.values()),
             "identityUncertain": self.identity_uncertain})
        return table

    def observe(self, data, incoming=False):
        try:
            message = json.loads(data)
        except (ValueError, UnicodeError):
            return
        if incoming and "id" in message:
            self.response_ids[message["id"]] = message.get("method")
            return
        method = message.get("method")
        result = message.get("result", {})
        if self.response_ids.get(message.get("id")) == "thread/start":
            self.thread_id = result.get("thread", {}).get("id")
            # These are native response observations, never copied from the request.
            self.observed = {"model": result.get("model"), "effort": result.get("reasoningEffort")}
        if self.response_ids.get(message.get("id")) == "config/read" and self.permissions:
            config = result.get("config", {})
            if without_nulls(config.get("permissions", {}).get(PROFILE_ID)) != self.permissions["profile"]:
                raise RuntimeError("effective native permission profile differs from the frozen profile")
        params = message.get("params", {})
        if method == "turn/started":
            self.session_id = str(params.get("threadId", self.thread_id)) + "-" + str(params.get("turn", {}).get("id"))
        item = params.get("item", {})
        if method == "item/completed" and item.get("type") == "agentMessage":
            self.final_text = item.get("text")
        if method == "turn/completed":
            status = params.get("turn", {}).get("status")
            self.stop_reason = "completed" if status in [None, "completed"] else "turn " + str(status)
            candidate = self.result_payload()
            if candidate["status"] == "in_review":
                save(self.directory / "result-candidate.json", candidate)

    def result_payload(self):
        summary = "Local execution did not produce a verified result"
        verification = []
        try:
            result = json.loads(self.final_text)
            if set(result) != {"summary", "verification"} or not isinstance(result["summary"], str) or not result["summary"].strip() or not isinstance(result["verification"], list) or not result["verification"] or any(not isinstance(v, str) or not v.strip() for v in result["verification"]):
                raise ValueError("invalid final result")
            summary, verification = result["summary"], result["verification"]
        except (ValueError, TypeError):
            pass
        artifacts = []
        cwd = pathlib.Path(self.execution["workspace"]["path"])
        for item in self.execution["artifacts"]:
            source = cwd / item["path"]
            try:
                if not source.resolve(strict=True).is_relative_to(cwd) or not source.is_file():
                    continue
                artifacts.append({"path": item["path"], "sha256": digest(source.read_bytes())})
            except OSError:
                continue
        complete = bool(verification) and self.stop_reason == "completed" and all(
            not item["required"] or any(a["path"] == item["path"] for a in artifacts) for item in self.execution["artifacts"])
        return {"status": "in_review" if complete else "failed", "summary": summary,
                "verification": verification, "artifacts": artifacts,
                "requested": {"model": self.execution["model"], "effort": self.execution["effort"]},
                "observed": self.observed, "sessionId": self.session_id,
                "process": self.identity, "stopReason": self.stop_reason}

    def request_stop(self, *_args):
        self.stopping = True

    def launch(self):
        guard = self.directory / "launch.guard"
        # Every exit, including validation failure, consumes this guard permanently.
        fd = os.open(guard, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(fd)
        # Survive termination of the scheduler's OS group long enough to observe
        # stdin EOF and stop the separately managed app-server group.
        if os.getpgrp() != os.getpid():
            os.setsid()
        for sig in [signal.SIGTERM, signal.SIGINT, signal.SIGHUP]:
            signal.signal(sig, self.request_stop)
        try:
            execution, binary, capability = validate_snapshot(self.snapshot)
            child_env = {key: value for key, value in os.environ.items() if key not in self.snapshot["secretEnvironmentNames"] and not key.startswith("CODEX_TASKBOARD_")}
            args, permissions = local_arguments(self.snapshot, execution, binary, child_env)
            self.permissions = permissions
            save(self.directory / "permissions.json", permissions, immutable=True)
            self.child = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                          cwd=execution["workspace"]["path"], env=child_env, start_new_session=True)
            self.identity.update({"childPid": self.child.pid, "processGroupId": self.child.pid})
            self.remember()
            save(self.directory / "launch.json", {"argv": args, "requested": {"model": execution["model"], "effort": execution["effort"]},
                  "binarySha256": capability["binary_sha256"], "capabilityObservedAt": capability["observed_at"],
                  "process": self.identity, "workspace": execution["workspace"]["path"]}, immutable=True)
            self.relay()
        except Exception as error:
            self.stop_reason = "supervisor error: " + type(error).__name__
            save(self.directory / "error.json", {"type": type(error).__name__, "message": str(error)[:1000]})
        finally:
            self.stop_tree()
            save(self.directory / "result.json", self.result_payload(), immutable=True)

    def relay(self):
        selector = selectors.DefaultSelector()
        selector.register(sys.stdin.buffer, selectors.EVENT_READ, "in")
        selector.register(self.child.stdout, selectors.EVENT_READ, "out")
        selector.register(self.child.stderr, selectors.EVENT_READ, "err")
        buffers = {"in": b"", "out": b""}
        last_observed = 0
        try:
            while not self.stopping:
                if time.monotonic() - last_observed > 0.2:
                    self.remember()
                    last_observed = time.monotonic()
                for key, _ in selector.select(0.1):
                    data = os.read(key.fileobj.fileno(), 65536)
                    channel = key.data
                    if not data:
                        selector.unregister(key.fileobj)
                        if channel in ["in", "out"]:
                            self.stopping = True
                        continue
                    if channel == "err":
                        # Bounded diagnostic tail, kept outside the Worker write root.
                        error_file = self.directory / "stderr.log"
                        previous = error_file.read_bytes() if error_file.exists() else b""
                        error_file.write_bytes((previous + data)[-65536:])
                        os.chmod(error_file, 0o600)
                        continue
                    buffers[channel] += data
                    while b"\n" in buffers[channel]:
                        line, buffers[channel] = buffers[channel].split(b"\n", 1)
                        self.observe(line, channel == "in")
                    target = self.child.stdin.fileno() if channel == "in" else sys.stdout.fileno()
                    while data:
                        count = os.write(target, data)
                        data = data[count:]
        except (BrokenPipeError, OSError):
            self.stopping = True
        finally:
            selector.close()

    def stop_tree(self):
        if not self.child:
            self.remember()
            table = processes()
        else:
            # Sample descendants before signaling, including observed escaped groups.
            # Reap a crashed direct child first: macOS may reject signaling its
            # zombie process group even though escaped descendants still live.
            self.child.poll()
            self.remember()
            for sig, grace in [(signal.SIGTERM, 3), (signal.SIGKILL, 3)]:
                table = processes()
                self.identity_uncertain |= any(record["pid"] in table and not same_process(table, record) for record in self.known.values())
                group = [entry for entry in table.values() if entry["pgid"] == self.child.pid]
                # After the leader exits, signal only individually verified
                # descendants. A reused leader must never grant group ownership.
                leader = self.known.get(self.child.pid)
                if leader and same_process(table, leader) and group and all(entry["pid"] in self.known and same_process(table, self.known[entry["pid"]]) for entry in group):
                    try:
                        os.killpg(self.child.pid, sig)
                    except (ProcessLookupError, PermissionError):
                        pass
                for record in self.known.values():
                    if same_process(table, record):
                        try:
                            os.kill(record["pid"], sig)
                        except (ProcessLookupError, PermissionError):
                            pass
                deadline = time.monotonic() + grace
                while time.monotonic() < deadline:
                    self.child.poll()  # Reap the direct child before declaring absence.
                    table = self.remember()
                    if not any(same_process(table, record) for record in self.known.values()) and not any(p["pgid"] == self.child.pid for p in table.values()):
                        break
                    time.sleep(0.05)
            table = processes()
        reused = any(record["pid"] in table and not same_process(table, record) for record in self.known.values())
        self.identity_uncertain |= reused
        alive = any(same_process(table, record) for record in self.known.values())
        group_empty = not self.child or not any(p["pgid"] == self.child.pid for p in table.values())
        if not self.identity_uncertain and not reused and not alive and group_empty:
            save(self.directory / "stop.json", {"state": "stopped", "observedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                 "process": self.identity, "groupEmpty": True,
                 "descendants": [dict(record, alive=False) for record in self.known.values()]}, immutable=True)


def observe_stopped(directory):
    directory = pathlib.Path(directory)
    stop = read_json(directory / "stop.json")
    table = processes()
    identity = stop["process"]
    # Even a different process with a reused PID remains uncertain; never kill it.
    if identity["wrapperPid"] in table or any(record["pid"] in table for record in stop["descendants"]):
        return False
    if identity["processGroupId"] is not None and any(p["pgid"] == identity["processGroupId"] for p in table.values()):
        return False
    print(canonical(stop))
    return True


if __name__ == "__main__":
    try:
        if len(sys.argv) == 3 and sys.argv[1] == "launch":
            Supervisor(sys.argv[2]).launch()
        elif len(sys.argv) == 3 and sys.argv[1] == "observe-stopped":
            sys.exit(0 if observe_stopped(sys.argv[2]) else 2)
        else:
            sys.exit("usage: supervisor.py launch|observe-stopped ATTEMPT_DIRECTORY")
    except (OSError, ValueError, KeyError, RuntimeError):
        sys.exit(2)
