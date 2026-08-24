# React 19 Patterns & Examples

## Migration Patterns (React 18 → 19)

### Pattern 1: Remove Unnecessary Memoization

```tsx
// ❌ React 18 pattern (over-memoized)
const UserCard = React.memo(function UserCard({ user }) {
  const fullName = useMemo(
    () => `${user.firstName} ${user.lastName}`,
    [user.firstName, user.lastName]
  );

  const handleClick = useCallback(() => {
    navigate(`/users/${user.id}`);
  }, [user.id]);

  return (
    <div onClick={handleClick}>
      <h2>{fullName}</h2>
    </div>
  );
});

// ✅ React 19 pattern (simple first; memoize only for a measured cost)
function UserCard({ user }) {
  const fullName = `${user.firstName} ${user.lastName}`;

  function handleClick() {
    navigate(`/users/${user.id}`);
  }

  return (
    <div onClick={handleClick}>
      <h2>{fullName}</h2>
    </div>
  );
}
```

### Pattern 2: Replace forwardRef

```tsx
// ❌ React 18
const Input = forwardRef<HTMLInputElement, InputProps>((props, ref) => {
  return <input ref={ref} className="input" {...props} />;
});

// ✅ React 19
function Input({ ref, ...props }: InputProps & { ref?: Ref<HTMLInputElement> }) {
  return <input ref={ref} className="input" {...props} />;
}
```

### Pattern 3: Replace useContext with use()

```tsx
// ❌ React 18 (can't use in conditions)
function UserProfile({ userId }) {
  const user = useContext(UserContext);  // Must be at top level

  if (!userId) return null;

  return <div>{user.name}</div>;
}

// ✅ React 19 (works anywhere)
function UserProfile({ userId }) {
  if (!userId) return null;

  const user = use(UserContext);  // Can be after early return!

  return <div>{user.name}</div>;
}
```

### Pattern 4: Simplify Context Providers

```tsx
// ❌ React 18
function App() {
  return (
    <ThemeContext.Provider value={theme}>
      <AuthContext.Provider value={auth}>
        <LocaleContext.Provider value={locale}>
          <Main />
        </LocaleContext.Provider>
      </AuthContext.Provider>
    </ThemeContext.Provider>
  );
}

// ✅ React 19
function App() {
  return (
    <ThemeContext value={theme}>
      <AuthContext value={auth}>
        <LocaleContext value={locale}>
          <Main />
        </LocaleContext>
      </AuthContext>
    </ThemeContext>
  );
}
```

---

## Common Patterns

### Async Data Loading with Suspense

```tsx
// data.ts
export async function fetchUser(id: string): Promise<User> {
  const res = await fetch(`/api/users/${id}`);
  return res.json();
}

// UserProfile.tsx
function UserProfile({ userId }) {
  const userPromise = fetchUser(userId);

  return (
    <Suspense fallback={<UserSkeleton />}>
      <UserDetails userPromise={userPromise} />
    </Suspense>
  );
}

function UserDetails({ userPromise }) {
  const user = use(userPromise);

  return (
    <div>
      <h1>{user.name}</h1>
      <p>{user.email}</p>
    </div>
  );
}
```

### Optimistic Form Submission

```tsx
interface Message {
  id: string;
  text: string;
  sending?: boolean;
}

function Chat({ messages, sendMessage }) {
  const [optimisticMessages, addOptimistic] = useOptimistic<Message[], Message>(
    messages,
    (state, newMessage) => [...state, { ...newMessage, sending: true }]
  );

  async function handleSubmit(formData: FormData) {
    const text = formData.get('message') as string;
    const newMessage = { id: crypto.randomUUID(), text };

    addOptimistic(newMessage);

    try {
      await sendMessage(newMessage);
    } catch (error) {
      // Optimistic update automatically reverts on error
      toast.error('Failed to send message');
    }
  }

  return (
    <>
      <ul>
        {optimisticMessages.map((msg) => (
          <li key={msg.id} className={msg.sending ? 'opacity-50' : ''}>
            {msg.text}
          </li>
        ))}
      </ul>
      <form action={handleSubmit}>
        <input name="message" />
        <button type="submit">Send</button>
      </form>
    </>
  );
}
```

### Form with Full Action State

```tsx
interface FormState {
  error: string | null;
  success: boolean;
}

function ContactForm() {
  const [state, formAction, isPending] = useActionState<FormState, FormData>(
    async (prevState, formData) => {
      const email = formData.get('email') as string;
      const message = formData.get('message') as string;

      if (!email.includes('@')) {
        return { error: 'Invalid email', success: false };
      }

      try {
        await submitContact({ email, message });
        return { error: null, success: true };
      } catch (e) {
        return { error: 'Submission failed', success: false };
      }
    },
    { error: null, success: false }
  );

  if (state.success) {
    return <p className="text-green-500">Thanks! We'll be in touch.</p>;
  }

  return (
    <form action={formAction}>
      <input name="email" type="email" placeholder="Email" />
      <textarea name="message" placeholder="Message" />

      {state.error && <p className="text-red-500">{state.error}</p>}

      <SubmitButton />
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();

  return (
    <button type="submit" disabled={pending}>
      {pending ? 'Sending...' : 'Send Message'}
    </button>
  );
}
```

### Non-Blocking Search with Transition

```tsx
function SearchPage() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Result[]>([]);
  const [isPending, startTransition] = useTransition();

  function handleSearch(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value;

    // Urgent: Update input immediately
    setQuery(value);

    // Non-urgent: Search can be deferred
    startTransition(async () => {
      const data = await search(value);
      setResults(data);
    });
  }

  return (
    <div>
      <input
        value={query}
        onChange={handleSearch}
        placeholder="Search..."
      />

      <div className="relative">
        {isPending && (
          <div className="absolute inset-0 bg-white/50">
            <Spinner />
          </div>
        )}
        <ResultsList results={results} />
      </div>
    </div>
  );
}
```

### Ref with Cleanup

```tsx
function VideoPlayer({ src }) {
  return (
    <video
      src={src}
      ref={(video) => {
        if (!video) return;

        // Setup: Add event listeners
        const handleEnded = () => console.log('Video ended');
        video.addEventListener('ended', handleEnded);

        // Cleanup: Remove when ref changes or unmounts
        return () => {
          video.removeEventListener('ended', handleEnded);
          video.pause();
        };
      }}
    />
  );
}
```

### Document Metadata per Route

```tsx
function ProductPage({ product }) {
  return (
    <>
      {/* Metadata — hoisted to <head> */}
      <title>{product.name} | MyStore</title>
      <meta name="description" content={product.description} />
      <meta property="og:title" content={product.name} />
      <meta property="og:image" content={product.image} />
      <link rel="canonical" href={`https://mystore.com/products/${product.slug}`} />

      {/* Content */}
      <article>
        <h1>{product.name}</h1>
        <img src={product.image} alt={product.name} />
        <p>{product.description}</p>
        <AddToCartButton productId={product.id} />
      </article>
    </>
  );
}
```

---

## Hook Decision Guide

| Need | Hook | Example |
|------|------|---------|
| Read context conditionally | `use()` | `const theme = use(ThemeContext)` |
| Immediate UI feedback | `useOptimistic()` | Like/unlike, add to cart |
| Track async action | `useActionState()` | Form submission with error handling |
| Form submit button state | `useFormStatus()` | Disable button while submitting |
| Non-urgent update | `useTransition()` | Search, filtering, sorting |
| Deferred value | `useDeferredValue()` | Expensive list rendering |
| Local state | `useState()` | Toggle, input value |
| Complex state logic | `useReducer()` | Multi-field forms, state machines |
| Side effects | `useEffect()` | Subscriptions, DOM manipulation |
| Stable reference | `useRef()` | DOM refs, mutable values |

---

## Anti-Patterns to Avoid

### Don't: Over-memoize

```tsx
// ❌ Unnecessary
const value = useMemo(() => items.length, [items]);

// ✅ Just compute it
const value = items.length;
```

### Don't: Put Frequently Changing Data in Context

```tsx
// ❌ Causes re-renders on every mouse move
<MousePositionContext value={{ x, y }}>

// ✅ Use local state or a dedicated library
const [position, setPosition] = useState({ x: 0, y: 0 });
```

### Don't: Forget Suspense Boundaries

```tsx
// ❌ Will throw if promise rejects
function Comments({ commentsPromise }) {
  const comments = use(commentsPromise);  // No Suspense above!
}

// ✅ Wrap with Suspense
<Suspense fallback={<Loading />}>
  <Comments commentsPromise={commentsPromise} />
</Suspense>
```

### Don't: Mix Async and Sync in useEffect

```tsx
// ❌ Async function as useEffect callback
useEffect(async () => {
  const data = await fetchData();
}, []);

// ✅ Define async function inside
useEffect(() => {
  async function load() {
    const data = await fetchData();
  }
  load();
}, []);

// ✅✅ Better: Use Suspense + use()
const data = use(fetchData());
```
