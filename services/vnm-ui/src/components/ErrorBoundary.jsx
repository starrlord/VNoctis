import { Component } from 'react';

/**
 * React error boundary that catches rendering errors in child components
 * and displays a friendly fallback UI instead of a blank screen.
 *
 * Resets error state when the user navigates to a different path.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    // Always log errors to console (development and production)
    console.error('[ErrorBoundary] Caught rendering error:', error, errorInfo);
  }

  componentDidUpdate(prevProps) {
    // Reset error state when navigation occurs (location changes)
    if (this.state.hasError && prevProps.children !== this.props.children) {
      this.setState({ hasError: false, error: null });
    }
  }

  handleReload = () => {
    window.location.reload();
  };

  handleBackToLibrary = () => {
    this.setState({ hasError: false, error: null });
    window.location.href = '/';
  };

  render() {
    if (this.state.hasError) {
      const isDev = import.meta.env.DEV;

      return (
        <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 px-4">
          <div className="max-w-md w-full text-center">
            {/* Error icon */}
            <div className="mx-auto w-16 h-16 mb-6 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
              <svg
                className="w-8 h-8 text-red-600 dark:text-red-400"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
                />
              </svg>
            </div>

            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2">
              Something went wrong
            </h1>

            <p className="text-gray-600 dark:text-gray-400 mb-6">
              An unexpected error occurred while rendering this page.
            </p>

            {/* Show error details in development mode only */}
            {isDev && this.state.error && (
              <div className="mb-6 p-4 bg-red-50 dark:bg-red-900/20 rounded-lg text-left">
                <p className="text-sm font-mono text-red-700 dark:text-red-300 break-words">
                  {this.state.error.message}
                </p>
                {this.state.error.stack && (
                  <pre className="mt-2 text-xs font-mono text-red-600 dark:text-red-400 overflow-auto max-h-48">
                    {this.state.error.stack}
                  </pre>
                )}
              </div>
            )}

            {/* Action buttons */}
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <button
                onClick={this.handleReload}
                className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg transition-colors duration-150"
              >
                Reload Page
              </button>

              <a
                href="/"
                onClick={(e) => {
                  e.preventDefault();
                  this.handleBackToLibrary();
                }}
                className="px-6 py-2.5 bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-900 dark:text-gray-100 font-medium rounded-lg transition-colors duration-150"
              >
                Back to Library
              </a>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
