import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Frontdesk — AI receptionist',
  description:
    'An AI receptionist that checks a real calendar, books the appointment, and escalates the calls it has no business handling.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
