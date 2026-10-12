using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;

namespace WindowsAgentTestBench
{
    // Windows 10+ in-box SQLite. No added package or schema, no alternative Registry.
    // The actual UI producer holds the same SQLite writer lock as Registry.revoke().
    internal sealed class BenchRegistryFence
    {
        [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
        private static extern int sqlite3_open16([MarshalAs(UnmanagedType.LPWStr)] string file, out IntPtr db);
        [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
        private static extern int sqlite3_close(IntPtr db);
        [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
        private static extern int sqlite3_busy_timeout(IntPtr db, int ms);
        [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
        private static extern int sqlite3_prepare16_v2(IntPtr db, [MarshalAs(UnmanagedType.LPWStr)] string sql,
            int bytes, out IntPtr stmt, IntPtr tail);
        [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
        private static extern int sqlite3_step(IntPtr stmt);
        [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
        private static extern IntPtr sqlite3_column_text16(IntPtr stmt, int column);
        [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
        private static extern int sqlite3_finalize(IntPtr stmt);
        private readonly string path;
        private readonly Dictionary<string, object> expected;
        private readonly JavaScriptSerializer json = new JavaScriptSerializer();
        internal BenchRegistryFence(string path, Dictionary<string, object> profile)
        {
            if (!System.IO.Path.IsPathRooted(path) || !System.IO.File.Exists(path)) throw new InvalidOperationException("authoritative-registry-required");
            this.path = path; expected = profile;
        }
        private static string Quote(object value) { return "'" + Convert.ToString(value).Replace("'", "''") + "'"; }
        private static List<string[]> Query(IntPtr db, string sql)
        {
            IntPtr stmt;
            if (sqlite3_prepare16_v2(db, sql, -1, out stmt, IntPtr.Zero) != 0) throw new InvalidOperationException("registry-query-unavailable");
            try {
                var rows = new List<string[]>();
                int code;
                while ((code = sqlite3_step(stmt)) == 100) {
                    // Queries deliberately have exactly one column.
                    rows.Add(new[] { Marshal.PtrToStringUni(sqlite3_column_text16(stmt, 0)) });
                    if (rows.Count > 128) throw new InvalidOperationException("registry-row-budget");
                }
                if (code != 101) throw new InvalidOperationException("registry-query-unconfirmed");
                return rows;
            } finally { sqlite3_finalize(stmt); }
        }
        private static string One(IntPtr db, string sql)
        {
            var rows = Query(db, sql);
            if (rows.Count != 1) throw new InvalidOperationException("registry-row-unavailable");
            return rows[0][0];
        }
        private void Check(IntPtr db)
        {
            var scope = (Dictionary<string, object>)expected["scope"];
            string where = "provider_id=" + Quote(scope["providerId"]) + " AND environment_id=" + Quote(scope["environmentId"]);
            if (One(db, "SELECT version FROM private_app_denial_store") != "1") throw new InvalidOperationException("registry-denial-schema-unavailable");
            if (Query(db, "SELECT 1 FROM private_app_denials WHERE " + where + " AND (app_binding_id=" + Quote(expected["appBindingId"]) +
                " OR installation_id=" + Quote(expected["installationId"]) + " OR application_id=" +
                Quote(((string)expected["applicationId"]).Normalize(System.Text.NormalizationForm.FormKC).ToLowerInvariant()) + ") LIMIT 1").Count != 0)
                throw new InvalidOperationException("app-denied");
            var current = json.Deserialize<Dictionary<string, object>>(One(db,
                "SELECT data_json FROM environment_apps WHERE " + where + " AND app_binding_id=" + Quote(expected["appBindingId"]) +
                " AND installation_scope_id=" + Quote(scope["installationScopeId"]) +
                " AND scope_revision=(SELECT scope_revision FROM app_environments WHERE " + where +
                " AND installation_scope_id=" + Quote(scope["installationScopeId"]) + ")"));
            foreach (var field in new[] { "scope", "appBindingId", "installationId", "applicationId", "profileRevision", "profileDigest", "identity", "launchSpec" }) {
                if (!current.ContainsKey(field) || !expected.ContainsKey(field) || json.Serialize(current[field]) != json.Serialize(expected[field]))
                    throw new InvalidOperationException("app-profile-changed");
            }
            if ((string)current["trust"] != "verified" || (string)current["validity"] != "current" || (string)current["availability"] != "available")
                throw new InvalidOperationException("app-trust-revoked-or-unavailable");
            bool confirmed = false;
            foreach (var item in (System.Collections.ArrayList)current["confirmations"]) {
                var confirmation = (Dictionary<string, object>)item;
                if (json.Serialize(confirmation["profileRevision"]) == json.Serialize(current["profileRevision"]) &&
                    (string)confirmation["profileDigest"] == (string)current["profileDigest"]) confirmed = true;
            }
            if (!confirmed) throw new InvalidOperationException("app-confirmation-required");
        }
        internal object Run(Func<object> commit)
        {
            IntPtr db;
            if (sqlite3_open16(path, out db) != 0) { if (db != IntPtr.Zero) sqlite3_close(db); throw new InvalidOperationException("registry-open-unavailable"); }
            try {
                sqlite3_busy_timeout(db, 1000);
                Query(db, "BEGIN IMMEDIATE");
                try { Check(db); return commit(); }
                finally { Query(db, "ROLLBACK"); }
            } finally { sqlite3_close(db); }
        }
    }
}
