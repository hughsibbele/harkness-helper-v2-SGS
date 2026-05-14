export { createBrowserDbClient } from "./browser";
export { createServerDbClient, type CookieAdapter } from "./server";
export { createAdminDbClient } from "./admin";
export type {
  Database,
  Json,
  Tables,
  TablesInsert,
  TablesUpdate,
} from "./database.types";
