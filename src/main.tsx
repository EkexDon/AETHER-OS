import React from "react";
import ReactDOM from "react-dom/client";
import "./styles/index.css";
import { App } from "./App";
import { ErrorBoundary } from "./components/system/ErrorBoundary";
import { installGlobalErrorHandlers } from "./lib/diagnostics";

installGlobalErrorHandlers();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary name="AETHER-OS" root>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
