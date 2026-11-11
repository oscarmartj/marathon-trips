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
      { source: '/admin/:path*', headers: [{ key: 'X-Frame-Options', value: 'DENY' }] },
    ];
  },
};
export default nextConfig;
