// Auth is now provided by the Google Workspace OAuth service. This module
// preserves the original import path so call-sites (server/routes.ts, the
// E2E bypass dynamic import) keep working without churn.
export {
  setupAuth,
  isAuthenticated,
  getSession,
} from "../../services/GoogleAuthService";
export { authStorage, type IAuthStorage } from "./storage";
export { registerAuthRoutes } from "./routes";
