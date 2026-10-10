import React from 'react'
import ReactDOM from 'react-dom/client'
import '@glideapps/glide-data-grid/dist/index.css'
import './styles/app.css'
import App from './App'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
