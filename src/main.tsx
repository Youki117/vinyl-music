// 必须排在所有其它 import 之前：给 musicSdk 补上 Buffer/process 全局，理由见该文件注释
import "./polyfill"

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
