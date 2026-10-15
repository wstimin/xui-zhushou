import React, { ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  override state: State = {
    hasError: false,
    error: null
  };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught Error in Component Tree:', error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  override render() {
    if (this.state.hasError) {
      return (
        <div className="error-page">
          <div className="error-card">
            <div className="error-icon">
              <AlertTriangle size={30} />
            </div>

            <div>
              <h2>页面运行时捕获到异常</h2>
              <p>
                应用遇到了意外的渲染错误。页面已自动受保护，未直接崩溃为白屏。
              </p>
            </div>

            {this.state.error && (
              <div className="error-detail">
                {this.state.error.message || String(this.state.error)}
              </div>
            )}

            <button
              onClick={this.handleReset}
              className="button button-primary button-block"
            >
              <RefreshCw size={16} />
              <span>刷新页面恢复</span>
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
