import { Component } from 'react'

/**
 * Without this, any exception during render or in an effect unmounts the whole
 * React tree and leaves a blank page — which is a miserable way to find out that
 * one cell misbehaved.
 */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('nbcollab crashed:', error, info?.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="crash">
        <h2>Something went wrong on this page</h2>
        <p className="muted">The notebook stopped rendering. Reloading usually fixes it.</p>
        <pre>{String(this.state.error?.message || this.state.error)}</pre>
        <button className="primary" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    )
  }
}
