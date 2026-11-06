// Small real Preact app with hooks.
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';

function App() {
  const [n, setN] = useState(0);
  const [q, setQ] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setTick(1), 1500);
    return () => clearTimeout(t);
  }, []);
  const fruits = ['apple', 'banana', 'cherry', 'damson'].filter((f) => f.includes(q));
  return (
    <main>
      <h1>Preact fixture</h1>
      <p id="n">Clicked {n} times</p>
      <button onClick={() => setN(n + 1)}>Click me</button>
      <input name="q" value={q} onInput={(e) => setQ(e.target.value)} placeholder="Filter fruit" />
      <ul>
        {fruits.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
      <p id="tick">{tick ? 'timer fired' : 'timer pending'}</p>
    </main>
  );
}

render(<App />, document.getElementById('app'));
