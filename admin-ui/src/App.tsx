import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./routes/Layout";
import { Login } from "./routes/Login";
import { Forgot } from "./routes/Forgot";
import { Reset } from "./routes/Reset";
import { Dashboard } from "./routes/Dashboard";
import { Visitors } from "./routes/Visitors";
import { VisitorDetail } from "./routes/VisitorDetail";
import { Submission } from "./routes/Submission";
import { AuditLog } from "./routes/AuditLog";

export function App() {
  return (
    <BrowserRouter basename="/admin">
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/forgot" element={<Forgot />} />
        <Route path="/reset" element={<Reset />} />
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="visitors" element={<Visitors />} />
          <Route path="visitors/:id" element={<VisitorDetail />} />
          <Route path="submissions/:id" element={<Submission />} />
          <Route path="audit" element={<AuditLog />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
