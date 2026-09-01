// Static DAG wave script. Packets stay on disk; this file never embeds node text.
const packetDir = process.env.PACKET_DIR;
if (!packetDir) throw new Error("PACKET_DIR is required");
const protocol = process.env.PROTOCOL || "craft";
const ids = (process.env.NODE_IDS ?? "").split(",").filter(Boolean);
if (ids.length === 0) throw new Error("NODE_IDS is required");
if (ids.length > 3) throw new Error("wave exceeds 3 nodes");

function mapEnv(raw, id) {
	const prefix = id + "=";
	for (const part of (raw ?? "").split(";")) {
		if (part.startsWith(prefix)) return part.slice(prefix.length);
	}
	throw new Error("missing mapping for " + id);
}

function packetPath(id) {
	return packetDir.replace(/\/?$/, "/") + id + ".json";
}

function textOf(result) {
	if (result == null) return "";
	if (typeof result === "string") return result;
	if (typeof result.output === "string") return result.output;
	try {
		return JSON.stringify(result);
	} catch {
		return String(result);
	}
}

function passed(result) {
	return /\bverdict:\s*pass\b/i.test(textOf(result)) || /"verdict"\s*:\s*"pass"/i.test(textOf(result));
}

function securityPassed(result) {
	const text = textOf(result);
	return /\bstatus:\s*passed\b/i.test(text) && !/\bstatus:\s*needs-fix\b/i.test(text);
}

function needsReplan(result) {
	const text = textOf(result);
	return /\bstatus:\s*needs-replan\b/i.test(text) || /\bblocking:\s*true\b/i.test(text);
}

function fresh(id) {
	return { context: "fresh", cwd: mapEnv(process.env.NODE_WORKTREES, id), worktree: false, acceptance: false };
}

function roleTask(role, id) {
	return (
		"Read only " +
		packetPath(id) +
		" and execute " +
		role +
		" for this DAG node. Protocol " +
		protocol +
		". Do not spawn subagents. Use the worktree and packet only."
	);
}

function metrics(id) {
	return mapEnv(process.env.NODE_RUNS, id);
}

function enter(id, phase, agent) {
	const extra = agent ? " --agent " + agent : "";
	return runs.host("enter-" + phase + "-" + id, {
		kind: "command",
		command: "craft-metrics enter --run " + metrics(id) + " --phase " + phase + extra,
	});
}

function exit(id, phase, args) {
	return runs.host("exit-" + phase + "-" + id, {
		kind: "command",
		command: "craft-metrics exit --run " + metrics(id) + " --phase " + phase + " " + args,
	});
}

function runNode(id) {
	const cwd = mapEnv(process.env.NODE_WORKTREES, id);
	const packet = packetPath(id);
	const opts = fresh(id);
	let chain = enter(id, "D").then(function () {
		return runs.host("d-" + id, {
			kind: "command",
			command: "craft-discover --task-source " + packet + " --cwd " + cwd,
		});
	}).then(function () {
		return exit(id, "D", "--reason report");
	}).then(function () {
		return enter(id, "C", "craft-planner");
	}).then(function () {
		return runs.run("c-" + id, Object.assign({ agent: "craft-planner", task: roleTask("C", id) }, opts));
	}).then(function (c) {
		return exit(id, "C", "--reason report --criteria-provenance provided --blocking-questions 0 --afk-hitl-status afk").then(function () {
			return c;
		});
	});
	if (protocol !== "craft-lite") {
		chain = chain.then(function (c) {
			return enter(id, "counsel", "craft-counsel").then(function () {
				return runs.run(
					"counsel-" + id,
					Object.assign({ agent: "craft-counsel", task: roleTask("counsel", id) + "\n" + textOf(c) }, opts),
				);
			}).then(function (counsel) {
				return exit(id, "counsel", "--reason report").then(function () {
					return { c: c, counsel: counsel };
				});
			});
		}).then(function (pair) {
			if (!needsReplan(pair.counsel)) return pair.c;
			return enter(id, "C", "craft-planner").then(function () {
				return runs.run(
					"c-rev-" + id,
					Object.assign({ agent: "craft-planner", task: roleTask("C revision", id) + "\n" + textOf(pair.counsel) }, opts),
				);
			}).then(function (revised) {
				return exit(id, "C", "--reason report --criteria-provenance provided --blocking-questions 0 --afk-hitl-status afk").then(function () {
					return revised;
				});
			});
		});
	}
	chain = chain.then(function () {
		return enter(id, "R", "craft-node-writer");
	}).then(function () {
		return runs.run("r-" + id, Object.assign({ agent: "craft-node-writer", task: roleTask("R", id) }, opts));
	}).then(function (r) {
		return exit(id, "R", "--reason report").then(function () {
			return r;
		});
	}).then(function () {
		return enter(id, "A", "craft-evaluator");
	}).then(function () {
		return runs.run("a-" + id, Object.assign({ agent: "craft-evaluator", task: roleTask("A", id) }, opts));
	}).then(function (a) {
		return exit(id, "A", passed(a) ? "--reason report --verdict pass --blocking-findings 0" : "--reason report --verdict fail --blocking-findings 1").then(function () {
			return a;
		});
	}).then(function (a) {
		if (passed(a)) return a;
		return enter(id, "F", "craft-node-writer").then(function () {
			return runs.run("f-" + id, Object.assign({ agent: "craft-node-writer", task: roleTask("F", id) + "\n" + textOf(a) }, opts));
		}).then(function () {
			return exit(id, "F", "--reason report");
		}).then(function () {
			return enter(id, "A", "craft-evaluator");
		}).then(function () {
			return runs.run("a2-" + id, Object.assign({ agent: "craft-evaluator", task: roleTask("A after Fix", id) }, opts));
		}).then(function (a2) {
			return exit(id, "A", passed(a2) ? "--reason report --verdict pass --blocking-findings 0" : "--reason report --verdict fail --blocking-findings 1").then(function () {
				return a2;
			});
		});
	});
	if (protocol !== "craft-lite") {
		chain = chain.then(function () {
			return enter(id, "T", "craft-security-review");
		}).then(function () {
			return runs.run("t-" + id, Object.assign({ agent: "craft-security-review", task: roleTask("T", id) }, opts));
		}).then(function (t) {
			return exit(id, "T", securityPassed(t) ? "--reason report --t-status pass --p0 0 --non-p0 0" : "--reason report --t-status fail --p0 1 --non-p0 0").then(function () {
				return t;
			});
		}).then(function (t) {
			if (securityPassed(t)) return t;
			return enter(id, "F", "craft-node-writer").then(function () {
				return runs.run("f-t-" + id, Object.assign({ agent: "craft-node-writer", task: roleTask("F for P0", id) + "\n" + textOf(t) }, opts));
			}).then(function () {
				return exit(id, "F", "--reason report");
			}).then(function () {
				return enter(id, "T", "craft-security-review");
			}).then(function () {
				return runs.run("t2-" + id, Object.assign({ agent: "craft-security-review", task: roleTask("T after Fix", id) }, opts));
			}).then(function (t2) {
				return exit(id, "T", securityPassed(t2) ? "--reason report --t-status pass --p0 0 --non-p0 0" : "--reason report --t-status fail --p0 1 --non-p0 0").then(function () {
					return t2;
				});
			});
		});
	}
	return chain
		.then(function () {
			return enter(id, "S");
		})
		.then(function () {
			return runs.run("s-" + id, Object.assign({ agent: "craft-node-writer", task: roleTask("S", id) }, opts));
		})
		.then(function (s) {
			return exit(id, "S", "--reason report --docs-touched 0").then(function () {
				return { id: id, status: "passed", result: s };
			});
		})
		.then(undefined, function (error) {
			return { id: id, status: "failed", error: String(error && error.message ? error.message : error) };
		});
}

const results = await Promise.all(ids.map(runNode));
return results;
