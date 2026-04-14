import { RouterProvider } from 'react-router';
import { router } from './routes';
import { TradingStoreProvider } from './store/TradingStore';
import { ErrorBoundary } from './ErrorBoundary';

export default function App() {
  return (
    <ErrorBoundary>
      <TradingStoreProvider>
        <RouterProvider router={router} />
      </TradingStoreProvider>
    </ErrorBoundary>
  );
}
