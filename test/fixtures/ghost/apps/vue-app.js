// Small real Vue 3 app, templates compiled at runtime (full build).
import { createApp, ref, onMounted, computed } from 'vue';

createApp({
  setup() {
    const todos = ref([]);
    const draft = ref('');
    const loaded = ref(false);
    const remaining = computed(() => todos.value.filter((t) => !t.done).length);
    onMounted(async () => {
      const r = await fetch('/api/todos');
      todos.value = (await r.json()).todos;
      loaded.value = true;
    });
    const add = () => {
      if (!draft.value.trim()) return;
      todos.value.push({ id: Date.now(), text: draft.value.trim(), done: false });
      draft.value = '';
    };
    return { todos, draft, loaded, remaining, add };
  },
  template: `
    <main>
      <h1>Vue fixture</h1>
      <p v-if="!loaded" class="loading">Loading todos…</p>
      <template v-else>
        <p id="remaining">{{ remaining }} of {{ todos.length }} remaining</p>
        <ul>
          <li v-for="t in todos" :key="t.id">
            <label><input type="checkbox" v-model="t.done" /> {{ t.text }}</label>
          </li>
        </ul>
        <form @submit.prevent="add">
          <input v-model="draft" name="draft" placeholder="New todo" />
          <button type="submit">Add</button>
        </form>
      </template>
    </main>`,
}).mount('#app');
