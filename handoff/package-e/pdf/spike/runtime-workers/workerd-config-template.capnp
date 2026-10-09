using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .probeWorker),
    (name = "deny-outbound", network = (allow = [], deny = [])),
  ],
  sockets = [
    (name = "http", address = "127.0.0.1:18897", http = (), service = "main"),
  ],
);

const probeWorker :Workerd.Worker = (
  modules = [
    (name = "worker-entry.mjs", esModule = embed "bundle/worker-entry.mjs"),
    (name = "./pdfjs-Cyp7QYX0.mjs", esModule = embed "bundle/pdfjs-Cyp7QYX0.mjs"),
  ],
  compatibilityDate = "2026-08-03",
  globalOutbound = "deny-outbound",
);
