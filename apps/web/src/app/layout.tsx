import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'UAI Agents Team',
  description: 'Multi-Agent Orchestration Dashboard',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="tr">
      <body>{children}</body>
    </html>
  );
}
