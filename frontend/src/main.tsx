import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import '@fontsource/newsreader/latin-400.css'
import '@fontsource/newsreader/latin-500.css'
import '@fontsource/newsreader/latin-400-italic.css'
import '@fontsource/instrument-sans/latin-400.css'
import '@fontsource/instrument-sans/latin-500.css'
import '@fontsource/instrument-sans/latin-600.css'
import './styles.css'
import { Layout } from './components'
import Pipeline from './pages/Pipeline'
import TargetPage from './pages/TargetPage'
import { CallPage, CallsList } from './pages/Calls'
import { FollowUps, Gatherings, Network, UsageSafety } from './pages/Other'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Pipeline />} />
          <Route path="/targets/:id" element={<TargetPage />} />
          <Route path="/calendar" element={<CallsList />} />
          <Route path="/calls" element={<CallsList />} />
          <Route path="/calls/:id" element={<CallPage />} />
          <Route path="/followups" element={<FollowUps />} />
          <Route path="/gatherings" element={<Gatherings />} />
          <Route path="/opportunities" element={<Gatherings />} />
          <Route path="/network" element={<Network />} />
          <Route path="/usage" element={<UsageSafety />} />
          <Route path="*" element={<p>Page not found.</p>} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
