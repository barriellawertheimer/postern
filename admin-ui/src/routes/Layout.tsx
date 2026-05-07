import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { api, HttpError } from "../api";
import { useAuth } from "../hooks/useAuth";

export function Layout() {
  const { checked, authenticated } = useAuth();
  const navigate = useNavigate();

  if (!checked) {
    return (
      <main className="container">
        <p aria-busy="true">Checking session…</p>
      </main>
    );
  }
  if (!authenticated) return null; // useAuth has already redirected

  async function logout() {
    try {
      await api("/logout", { method: "POST" });
    } catch (err) {
      // Even if the request fails, navigate to /login — the cookie may
      // still be set, but the user clearly wants out.
      if (!(err instanceof HttpError) || err.status !== 401) {
        // eslint-disable-next-line no-console
        console.warn("logout request failed", err);
      }
    }
    navigate("/login", { replace: true });
  }

  return (
    <>
      <nav className="container app-nav">
        <ul>
          <li>
            <strong>Postern admin</strong>
          </li>
        </ul>
        <ul>
          <li>
            <NavLink to="/" end>
              Dashboard
            </NavLink>
          </li>
          <li>
            <NavLink to="/visitors">Visitors</NavLink>
          </li>
          <li>
            <NavLink to="/audit">Audit log</NavLink>
          </li>
          <li>
            <button type="button" className="secondary" onClick={() => void logout()}>
              Logout
            </button>
          </li>
        </ul>
      </nav>
      <main className="container">
        <Outlet />
      </main>
    </>
  );
}
