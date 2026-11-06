// Small real React app: state, an effect that fetches JSON, a controlled form, pushState routing.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

function useRoute() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const on = () => setPath(window.location.pathname);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  const go = (to) => (e) => {
    e.preventDefault();
    window.history.pushState({ to }, '', to);
    setPath(to);
  };
  return [path, go];
}

function Items() {
  const [items, setItems] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    fetch('/api/items')
      .then((r) => r.json())
      .then((d) => live && setItems(d.items))
      .catch((e) => live && setErr(String(e)));
    return () => {
      live = false;
    };
  }, []);
  if (err) return <p className="err">failed: {err}</p>;
  if (!items) return <p className="loading">Loading items…</p>;
  return (
    <ul id="items">
      {items.map((it) => (
        <li key={it.id}>
          {it.name} — ${it.price}
        </li>
      ))}
    </ul>
  );
}

function Greeter() {
  const [name, setName] = useState('');
  const [agree, setAgree] = useState(false);
  const [plan, setPlan] = useState('free');
  const [sent, setSent] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setSent(`Hello, ${name}! plan=${plan} agree=${agree}`);
      }}
    >
      <label htmlFor="name">Name</label>
      <input id="name" name="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
      <label>
        <input type="checkbox" name="agree" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> I agree
      </label>
      <select name="plan" value={plan} onChange={(e) => setPlan(e.target.value)}>
        <option value="free">Free</option>
        <option value="pro">Pro</option>
      </select>
      <button type="submit">Greet</button>
      <p id="echo">typed: {name}</p>
      {sent && <p id="greeting">{sent}</p>}
    </form>
  );
}

function App() {
  const [path, go] = useRoute();
  const [count, setCount] = useState(0);
  const [hovered, setHovered] = useState(false);
  return (
    <div>
      <nav>
        <a href="/react/" onClick={go('/react/')}>Home</a> <a href="/react/about" onClick={go('/react/about')}>About</a>
      </nav>
      {path.endsWith('/about') ? (
        <main>
          <h1>About this app</h1>
          <p>Routed with pushState, path is {path}</p>
        </main>
      ) : (
        <main>
          <h1>React fixture</h1>
          <p id="count">Count: {count}</p>
          <button id="inc" onClick={() => setCount((c) => c + 1)}>
            Increment
          </button>
          <div id="hover" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} role="button" tabIndex={0}>
            {hovered ? 'hovering' : 'not hovering'}
          </div>
          <Items />
          <Greeter />
        </main>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
