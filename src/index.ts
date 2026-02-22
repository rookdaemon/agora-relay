/**
 * @rookdaemon/agora-relay — Re-exports relay types and helpers from @rookdaemon/agora
 * plus local config loading for the CLI.
 */

export {
  RelayServer,
  MessageStore,
  MessageBuffer,
  runRelay,
  createRestRouter,
  type RelayServerOptions,
  type RunRelayOptions,
  type RestSession,
  type RelayInterface,
} from "@rookdaemon/agora";

export { loadConfig, Config, AGORA_HOME } from "./config.js";
