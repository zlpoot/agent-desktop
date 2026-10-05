import { SqliteTrace } from "./trace/sqlite-trace.js";

const path = process.argv[2];
if (!path) {
  console.error("用法：npm run grounding:stats -- <数据库路径> [任务 ID]");
  process.exit(1);
}
const trace = new SqliteTrace(path);
try {
  console.table(trace.groundingStats(process.argv[3]));
} finally {
  trace.close();
}
