/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  // Pages that read a one-time token from the URL fragment never send a Referer (plan 4.1).
  async headers() {
    const noReferrer = [{ key: 'Referrer-Policy', value: 'no-referrer' }];
    return [
      { source: '/account/sign-in/verify', headers: noReferrer },
      { source: '/admin/enrol', headers: noReferrer },
      // Task 5.1: a payment link's page holds a token from the fragment; neither page is framed or sends a Referer.
      { source: '/pay', headers: [...noReferrer, { key: 'X-Frame-Options', value: 'DENY' }] },
      { source: '/pay/return', headers: [...noReferrer, { key: 'X-Frame-Options', value: 'DENY' }] },
      // Task 5.5: the unsubscribe page reads the email's reference from the fragment.
      { source: '/unsubscribe', headers: noReferrer },
      { source: '/admin/:path*', headers: [{ key: 'X-Frame-Options', value: 'DENY' }] },
    ];
  },
};
export default nextConfig;
