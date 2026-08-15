import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import App from "./App"
import "./styles/tokens.css"
import "./styles/stage.css"
import "./styles/ui.css"

const root = document.getElementById("root")
if (!root) throw new Error("找不到 #root 挂载点")

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
