import { TABLES, buildCreateTableSql } from "../schema.js";

export default {
  version: 2,
  name: "api-key-acl",
  up(db) {
    for (const table of ["apiKeyAcl", "apiKeyQuotaUsage", "apiKeyLifetimeQuotaUsage", "apiKeyQuotaReservations"]) {
      const definition = TABLES[table];
      db.exec(buildCreateTableSql(table, definition));
      for (const index of definition.indexes || []) db.exec(index);
    }
  },
};
