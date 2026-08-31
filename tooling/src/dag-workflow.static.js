// Static DAG launch script. Reads node packets from PACKET_DIR; never interpolates task text.
const packetDir = process.env.PACKET_DIR;
if (!packetDir) throw new Error("PACKET_DIR is required");
const ids = (process.env.NODE_IDS ?? "").split(",").filter(Boolean);
for (const id of ids) {
	const path = packetDir.replace(/\/?$/, "/") + id + ".json";
	void path;
}
