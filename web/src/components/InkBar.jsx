const PATHS = {
  pen: (
    <>
      <path d="M3 21l1.2-4.2L15.4 5.6a2 2 0 0 1 2.8 0l.2.2a2 2 0 0 1 0 2.8L7.2 19.8z" />
      <path d="M13.8 7.2l3 3" />
    </>
  ),
  highlight: (
    <>
      <path d="M4 19h16" />
      <path d="M6.5 15.5l9.8-9.8 2.5 2.5L9 18H6.5z" />
    </>
  ),
  erase: (
    <>
      <path d="M8.5 20H20" />
      <path d="M14.8 4.6l4.6 4.6a1.5 1.5 0 0 1 0 2.1l-6.6 6.6H9.1L4.9 15a1.5 1.5 0 0 1 0-2.1l7.8-8.3a1.5 1.5 0 0 1 2.1 0z" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M4 4l16 16" />
      <path d="M9.5 6.4A9.6 9.6 0 0 1 12 5.8c6 0 9.5 6.2 9.5 6.2a17 17 0 0 1-3.4 4.1" />
      <path d="M6.6 8.1A16.6 16.6 0 0 0 2.5 12S6 18.2 12 18.2c1.6 0 3-.5 4.2-1.1" />
      <path d="M10.2 10.4a2.8 2.8 0 0 0 3.7 3.8" />
    </>
  ),
  trash: (
    <>
      <path d="M4 6.5h16" />
      <path d="M9.5 6.5V4.8a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.7" />
      <path d="M6.5 6.5l.9 12.1a1.4 1.4 0 0 0 1.4 1.3h6.4a1.4 1.4 0 0 0 1.4-1.3l.9-12.1" />
      <path d="M10.3 10.2v6M13.7 10.2v6" />
    </>
  ),
}

function Icon({ name }) {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        {PATHS[name]}
      </g>
    </svg>
  )
}

const TOOLS = [
  { id: 'pen', icon: 'pen', title: 'Pen — draw on the notebook for everyone' },
  { id: 'highlight', icon: 'highlight', title: 'Highlighter' },
  { id: 'erase', icon: 'erase', title: 'Eraser — wipes ink everyone can see' },
]

export function InkBar({ ink }) {
  return (
    <div className="ink-bar">
      {TOOLS.map((t) => (
        <button
          key={t.id}
          className={ink.mode === t.id ? 'tool on' : 'tool'}
          title={t.title}
          aria-label={t.title}
          aria-pressed={ink.mode === t.id}
          onClick={() => ink.toggle(t.id)}
        >
          <Icon name={t.icon} />
        </button>
      ))}

      <input
        type="color"
        value={ink.color}
        onChange={(e) => ink.setColor(e.target.value)}
        title="Ink colour"
        aria-label="Ink colour"
      />

      <button
        className="tool"
        title={ink.visible ? 'Hide drawings for me only' : 'Show drawings'}
        aria-label={ink.visible ? 'Hide drawings for me only' : 'Show drawings'}
        aria-pressed={ink.visible}
        onClick={() => ink.setVisible(!ink.visible)}
      >
        <Icon name={ink.visible ? 'eye' : 'eyeOff'} />
      </button>

      <button
        className="tool danger"
        title="Clear every drawing for everyone"
        aria-label="Clear every drawing for everyone"
        onClick={() => {
          if (ink.count > 0 && !window.confirm('Clear all drawings for everyone?')) return
          ink.clear()
        }}
      >
        <Icon name="trash" />
      </button>

      {ink.armed && (
        <span className="ink-hint">
          {ink.mode === 'erase' ? 'Drag to erase for everyone' : 'Drag to draw — everyone sees it'}
        </span>
      )}
    </div>
  )
}
