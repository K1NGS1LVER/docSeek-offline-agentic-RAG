import { useState, useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import LandingPage from './pages/LandingPage'
import Workspace from './pages/Workspace'

export default function App() {
  const [theme, setTheme] = useState(() => {
    return localStorage.getItem('ds_theme') || 'light'
  })

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('ds_theme', theme)
  }, [theme])

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LandingPage theme={theme} setTheme={setTheme} />} />
        <Route path="/app" element={<Workspace theme={theme} setTheme={setTheme} />} />
        <Route path="*" element={<Navigate to="/app" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
