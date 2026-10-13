import React from "react";
import ReactDOM from "react-dom/client";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles/globals.css";

const url = import.meta.env.VITE_CONVEX_URL;
const convex = url ? new ConvexReactClient(url) : null;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {convex ? <ErrorBoundary><ConvexAuthProvider client={convex}><App /></ConvexAuthProvider></ErrorBoundary> : (
      <main className="flex h-dvh flex-col items-center justify-center gap-3 p-6 text-center">
        <h1 className="m-0 text-2xl font-semibold">Colony</h1>
        <p className="m-0 text-muted">Connect the Convex backend, then restart so the app can read VITE_CONVEX_URL from .env.local.</p>
        <pre className="rounded-lg bg-raised px-3.5 py-2.5 font-mono">npm run backend</pre>
      </main>
    )}
  </React.StrictMode>,
);
