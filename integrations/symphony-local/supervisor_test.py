"""Controlled process/stdio tests: no real Codex, model calls, tracker or issue service."""
import importlib.util
import json
import os
import pathlib
import select
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("local_supervisor", pathlib.Path(__file__).with_name("supervisor.py"))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

FAKE = r'''#!PYTHON
import json,os,pathlib,re,signal,subprocess,sys,time
settings={}
for i,arg in enumerate(sys.argv):
    if arg=='-c':
        k,v=sys.argv[i+1].split('=',1)
        settings[k]=json.loads(re.sub(r'("(?:[^"\\]|\\.)*")=',r'\1:',v)) if k.startswith("permissions.") else json.loads(v)
if sys.argv[-3:]==["mcp","list","--json"]:
    print("[]");sys.exit(0)
if pathlib.Path('profile-merge').exists():settings['permissions.taskboard_local']['filesystem']['/unexpected']='write'
pathlib.Path('consumed.json').write_text(json.dumps({'settings':settings,'secretPresent':'LOCAL_TEST_SECRET' in os.environ}))
child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(300)'],start_new_session=True)
def stop(*_):
    try:child.wait(timeout=4)
    except subprocess.TimeoutExpired:pass
    sys.exit(0)
signal.signal(signal.SIGTERM,stop)
pathlib.Path('descendant.pid').write_text(str(child.pid))
time.sleep(0.3)
def send(v):
    print(json.dumps(v),flush=True)
for line in sys.stdin:
    msg=json.loads(line);method=msg.get('method');rid=msg.get('id')
    if method=='initialize':send({'id':rid,'result':{}})
    if method=='permissionProfile/list':send({'id':rid,'result':{'data':[{'id':'taskboard_local','allowed':True}]}})
    if method=='experimentalFeature/list':send({'id':rid,'result':{'data':[{'name':key.split('.',1)[1],'enabled':value,'stage':'stable'} for key,value in settings.items() if key.startswith('features.')]}})
    if method=='config/read':send({'id':rid,'result':{'config':{'permissions':{'taskboard_local':settings['permissions.taskboard_local']},'web_search':'disabled','mcp_servers':{}}}})
    if method=='mcpServerStatus/list':send({'id':rid,'result':{'data':[]}})
    if method=='thread/start':send({'id':rid,'result':{'thread':{'id':'native-fixture'},'activePermissionProfile':{'id':'taskboard_local'},'model':settings['model'],'reasoningEffort':settings['model_reasoning_effort']}})
    if method=='turn/start':
        if pathlib.Path('crash').exists():
            pathlib.Path('crashing').write_text('exit 23')
            os._exit(23)
        if pathlib.Path('hold').exists():time.sleep(30)
        send({'id':rid,'result':{'turn':{'id':'turn-fixture'}}})
        send({'method':'turn/started','params':{'threadId':'native-fixture','turn':{'id':'turn-fixture'}}})
        pathlib.Path('output.md').write_text('controlled output')
        send({'method':'item/completed','params':{'item':{'type':'agentMessage','text':json.dumps({'summary':'Controlled output created','verification':['Compared fixture output']})}}})
        send({'method':'turn/completed','params':{'turn':{'id':'turn-fixture','status':'completed'}}})
'''


class SupervisorTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="local-supervisor-")
        self.root = pathlib.Path(self.temp.name).resolve()
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        self.attempt = self.root / "attempt"
        self.attempt.mkdir()
        self.binary = self.root / "fake-codex"
        self.binary.write_text(FAKE.replace("PYTHON", sys.executable, 1))
        self.binary.chmod(0o700)
        (self.root / "inputs").mkdir()
        self.input = self.root / "inputs/input.txt"
        self.input.write_text("fixed")
        self.input.chmod(0o444)
        self.capability = self.root / "capabilities.json"
        self.capability.write_text(json.dumps({"entry": [str(self.binary)], "binary_sha256": MODULE.digest(self.binary.read_bytes()),
            "observed_at": "fixture", "result": {"models": [
                {"model": "model-A", "supportedReasoningEfforts": [{"reasoningEffort": "medium"}]},
                {"model": "model-B", "supportedReasoningEfforts": [{"reasoningEffort": "high"}]}]}}))
        self.execution = {"model": "model-A", "effort": "medium", "workspace": {"path": str(self.workspace)},
            "inputs": [{"path": str(self.input), "sha256": MODULE.digest(b"fixed")}],
            "artifacts": [{"path": "output.md", "required": True}], "git": None, "authority": {"network": "model-only"}}
        self.process = None
        self.processes = []

    def tearDown(self):
        for process in self.processes:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=10)
            for stream in [process.stdin, process.stdout, process.stderr]:
                if stream and not stream.closed:
                    stream.close()
        pidfile = self.workspace / "descendant.pid"
        if pidfile.exists():
            try:
                os.kill(int(pidfile.read_text()), signal.SIGKILL)
            except ProcessLookupError:
                pass
        self.temp.cleanup()

    def start(self):
        MODULE.save(self.attempt / "snapshot.json", {"release": {"execution": self.execution,
            "executionHash": MODULE.digest(MODULE.canonical(self.execution).encode())},
            "capabilityFile": str(self.capability), "secretEnvironmentNames": ["LOCAL_TEST_SECRET"],
            "protection": {"inputRoot": str(self.input.parent), "deniedPaths": [str(self.attempt)]}})
        self.process = subprocess.Popen([sys.executable, str(pathlib.Path(__file__).with_name("supervisor.py")), "launch", str(self.attempt)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0, env=dict(os.environ, LOCAL_TEST_SECRET="never-forward"))
        self.processes.append(self.process)

    def send(self, request):
        self.process.stdin.write((json.dumps(request) + "\n").encode())
        self.process.stdin.flush()

    def response(self):
        if not select.select([self.process.stdout], [], [], 10)[0]:
            self.fail("controlled protocol response timed out")
        line = self.process.stdout.readline()
        self.assertTrue(line, "supervisor exited before response")
        return json.loads(line)

    def finish(self):
        self.process.stdin.close()
        self.process.wait(timeout=12)
        self.assertEqual(self.process.returncode, 0, self.process.stderr.read().decode())
        command = [sys.executable, str(pathlib.Path(__file__).with_name("supervisor.py")), "observe-stopped", str(self.attempt)]
        observed = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(observed.returncode, 0, observed.stderr)
        return json.loads(observed.stdout)

    def test_per_process_settings_stop_tree_secret_removal_and_guard(self):
        for model, effort in [("model-A", "medium"), ("model-B", "high")]:
            with self.subTest(model=model):
                if model == "model-B":
                    self.attempt = self.root / "attempt-B"
                    self.attempt.mkdir()
                self.execution.update(model=model, effort=effort)
                self.start()
                self.send({"id": 1, "method": "initialize"}); self.response()
                self.send({"id": 2, "method": "thread/start"}); self.response()
                self.send({"id": 3, "method": "turn/start"})
                while self.response().get("method") != "turn/completed":
                    pass
                stop = self.finish()
                self.assertTrue(stop["groupEmpty"])
                self.assertGreaterEqual(len(stop["descendants"]), 2)
                consumed = MODULE.read_json(self.workspace / "consumed.json")
                self.assertFalse(consumed["secretPresent"])
                self.assertEqual(consumed["settings"]["model"], model)
                self.assertTrue(consumed["settings"]["features.code_mode_host"])
                self.assertEqual(len(MODULE.DISABLED_FEATURES), 27)
                self.assertTrue(all(consumed["settings"]["features." + name] is False for name in MODULE.DISABLED_FEATURES))
                result = MODULE.read_json(self.attempt / "result.json")
                self.assertEqual(result["observed"], {"model": model, "effort": effort})
                self.assertEqual(result["status"], "in_review")
                duplicate = subprocess.run([sys.executable, str(pathlib.Path(__file__).with_name("supervisor.py")), "launch", str(self.attempt)], capture_output=True)
                self.assertEqual(duplicate.returncode, 2)

    def test_input_change_prevents_child_and_missing_result_is_failure(self):
        self.execution["inputs"][0]["sha256"] = "a" * 64
        self.start()
        self.process.wait(timeout=10)
        self.assertFalse((self.workspace / "consumed.json").exists())
        self.assertEqual(MODULE.read_json(self.attempt / "result.json")["status"], "failed")
        self.assertIsNone(MODULE.read_json(self.attempt / "stop.json")["process"]["childPid"])

    def test_effective_profile_merge_is_rejected_before_thread_or_turn(self):
        (self.workspace / "profile-merge").touch()
        self.start()
        self.send({"id": 1, "method": "initialize"}); self.response()
        self.send({"id": 6, "method": "config/read"})
        self.process.wait(timeout=12)
        self.assertEqual(self.process.stdout.read(), b"")
        self.assertIn("differs from the frozen profile", MODULE.read_json(self.attempt / "error.json")["message"])
        self.assertEqual(MODULE.read_json(self.attempt / "result.json")["status"], "failed")
        self.assertTrue(MODULE.read_json(self.attempt / "stop.json")["groupEmpty"])

    def test_live_wrapper_never_counts_as_stopped(self):
        MODULE.save(self.attempt / "stop.json", {"process": {"wrapperPid": os.getpid(), "processGroupId": None}, "descendants": []})
        self.assertFalse(MODULE.observe_stopped(self.attempt))

    def test_abrupt_app_server_exit_still_stops_observed_escaped_child(self):
        (self.workspace / "crash").touch()
        self.start()
        self.send({"id": 1, "method": "initialize"}); self.response()
        self.send({"id": 2, "method": "thread/start"}); self.response()
        self.send({"id": 3, "method": "turn/start"})
        deadline = time.monotonic() + 5
        while not (self.workspace / "crashing").exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue((self.workspace / "crashing").exists())
        stop = self.finish()
        self.assertTrue(stop["groupEmpty"])
        escaped_pid = int((self.workspace / "descendant.pid").read_text())
        self.assertIn(escaped_pid, [record["pid"] for record in stop["descendants"]])
        self.assertNotIn(escaped_pid, MODULE.processes())
        self.assertEqual(MODULE.read_json(self.attempt / "result.json")["status"], "failed")


class ProcessIdentityTest(unittest.TestCase):
    """PID reuse is deterministic here; every signal and process table is fake."""

    def test_reused_descendant_or_leader_never_claims_unrelated_family(self):
        for reused_pid in [600, 501]:
            with self.subTest(reused_pid=reused_pid), tempfile.TemporaryDirectory() as directory:
                supervisor = MODULE.Supervisor.__new__(MODULE.Supervisor)
                supervisor.directory = pathlib.Path(directory)
                supervisor.identity = {"wrapperPid": 500, "childPid": 501, "processGroupId": 501}
                supervisor.identity_uncertain = False
                supervisor.child = SimpleNamespace(pid=501, returncode=None, poll=lambda: None)
                supervisor.known = {pid: {"pid": pid, "birth": str(pid)} for pid in [501, 600]}
                table = {501: {"pid": 501, "ppid": 500, "pgid": 501, "birth": "501"},
                         600: {"pid": 600, "ppid": 1, "pgid": 600, "birth": "600"}}
                table[reused_pid]["birth"] = "unrelated-reuse"
                table[601] = {"pid": 601, "ppid": reused_pid, "pgid": reused_pid, "birth": "unrelated-child"}
                clock = iter(range(0, 10000, 10))  # Skip grace waits, keep both signal stages.
                with patch.object(MODULE, "processes", return_value=table), \
                     patch.object(MODULE.os, "kill") as kill, patch.object(MODULE.os, "killpg") as killpg, \
                     patch.object(MODULE.time, "monotonic", side_effect=lambda: next(clock)):
                    supervisor.remember()
                    self.assertNotIn(601, supervisor.known)
                    supervisor.stop_tree()
                    self.assertTrue(supervisor.identity_uncertain)
                    self.assertTrue(all(call.args[0] not in [reused_pid, 601] for call in kill.call_args_list))
                    if reused_pid == 501:
                        killpg.assert_not_called()
                    else:
                        self.assertEqual([call.args for call in kill.call_args_list], [(501, signal.SIGTERM), (501, signal.SIGKILL)])
                    self.assertFalse((supervisor.directory / "stop.json").exists())
                    # Disappearance of the reused process cannot erase uncertainty.
                    table.clear()
                    supervisor.stop_tree()
                    self.assertFalse((supervisor.directory / "stop.json").exists())
                    self.assertTrue(MODULE.read_json(supervisor.directory / "process.json")["identityUncertain"])

    def test_matching_escaped_parent_still_discovers_child_after_leader_exit(self):
        with tempfile.TemporaryDirectory() as directory:
            supervisor = MODULE.Supervisor.__new__(MODULE.Supervisor)
            supervisor.directory = pathlib.Path(directory)
            supervisor.identity = {"wrapperPid": 500, "childPid": 501, "processGroupId": 501}
            supervisor.identity_uncertain = False
            supervisor.child = SimpleNamespace(pid=501, returncode=23, poll=lambda: 23)
            supervisor.known = {pid: {"pid": pid, "birth": str(pid)} for pid in [501, 600]}
            table = {600: {"pid": 600, "ppid": 1, "pgid": 600, "birth": "600"},
                     601: {"pid": 601, "ppid": 600, "pgid": 601, "birth": "escaped-grandchild"}}
            with patch.object(MODULE, "processes", return_value=table):
                supervisor.remember()
                self.assertEqual(supervisor.known[601]["birth"], "escaped-grandchild")
                self.assertFalse(supervisor.identity_uncertain)
                table.clear()
                supervisor.stop_tree()
                self.assertTrue((supervisor.directory / "stop.json").exists())


if __name__ == "__main__":
    unittest.main()
