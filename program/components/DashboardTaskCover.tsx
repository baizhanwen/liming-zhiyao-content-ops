const covers = {
  video_analysis: <>
    <rect width="48" height="48" fill="#c9e8df"/>
    <circle cx="35" cy="12" r="6" fill="#f4c76d"/>
    <path d="m-3 43 20-27 21 28z" fill="#69ab95"/>
    <path d="m8 48 25-28 24 28z" fill="#286b64"/>
    <path d="m-3 37 15-3 18 14H0z" fill="#88cdac"/>
    <path d="m1 45 14-11 6 4-14 10z" fill="#4e9c80"/>
  </>,
  topic: <>
    <rect width="48" height="48" fill="#efd9cb"/>
    <circle cx="14" cy="12" r="8" fill="#f9b762"/>
    <path d="M0 40c7-6 15-7 24-3s18 1 24-5v16H0z" fill="#c76c55"/>
    <path d="M19 42V24c0-9 5-15 11-15s10 7 10 16v17z" fill="#bc7f71"/>
    <path d="M22 43V25c0-8 3-13 8-13s7 6 7 13v18" fill="none" stroke="#f7dac8" strokeWidth="1.4"/>
    <path d="M26 44V26c0-6 2-10 4-10s4 5 4 11v17" fill="none" stroke="#f7dac8" strokeWidth="1.4"/>
    <path d="M0 39q14-5 27 4t21-1v6H0z" fill="#884f4b"/>
  </>,
  review: <>
    <rect width="48" height="48" fill="#ccdce8"/>
    <circle cx="34" cy="12" r="6.5" fill="#f7e7b5"/>
    <path d="M0 34q10-11 24-4t24-8v26H0z" fill="#8ca7b6"/>
    <path d="m6 36 10-23v23z" fill="#f9e7cd"/>
    <path d="M18 14v21h11z" fill="#f7b17e"/>
    <path d="m4 36 25-1-5 5H8z" fill="#365c68"/>
    <path d="M0 40q12-5 22 0t26-3v11H0z" fill="#4d7f92"/>
    <path d="M20 44q5-2 9-1m-23 1 6-1" fill="none" stroke="#a2c3cc" strokeLinecap="round"/>
  </>,
  content: <>
    <rect width="48" height="48" fill="#eee1b6"/>
    <circle cx="31" cy="15" r="8" fill="#df975c"/>
    <path d="m-3 43 15-24 16 23z" fill="#a8ab75"/>
    <path d="m4 49 27-25 20 23z" fill="#627e64"/>
    <path d="m29 49 15-16 11 16z" fill="#335f55"/>
  </>,
  publish: <>
    <rect width="48" height="48" fill="#e4d9ea"/>
    <path d="M9 50V24a15 15 0 0 1 30 0v26z" fill="#a798b5"/>
    <path d="M15 50V25a9 9 0 0 1 18 0v25z" fill="#f4dfcc"/>
    <circle cx="36" cy="12" r="6" fill="#eab071"/>
    <path d="m0 47 12-10 16 10z" fill="#826b8b"/>
  </>,
};

export function DashboardTaskCover({ type }: { type: keyof typeof covers | "custom" }) {
  return <svg className="home-cover" aria-hidden="true" width="40" height="40" viewBox="0 0 48 48">
    {covers[type === "custom" ? "topic" : type]}
  </svg>;
}
