import React from "react";
import ReactDOM from "react-dom/client";
import { LazyMotion, MotionConfig, domMax } from "motion/react";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { startLive } from "./lib/live";
import { registerServiceWorker } from "./lib/push";
import "./styles/globals.css";

void startLive();
registerServiceWorker();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {/* One motion setup for the app: lazy features keep the bundle small; reducedMotion follows the OS setting. */}
    <LazyMotion features={domMax} strict>
      <MotionConfig reducedMotion="user">
        <ErrorBoundary><App /></ErrorBoundary>
      </MotionConfig>
    </LazyMotion>
  </React.StrictMode>,
);
