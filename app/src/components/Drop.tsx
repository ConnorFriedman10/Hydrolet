// The Hydrolet water drop, used in the header and on the login screen.
// Decorative: the word "Hydrolet" always sits next to it.
export default function Drop({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="drop-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#5fd0ef" />
          <stop offset="1" stopColor="#0a5ea8" />
        </linearGradient>
      </defs>
      <path d="M16 2.5C11 10 7 14.6 7 20a9 9 0 0 0 18 0c0-5.4-4-10-9-17.5z" fill="url(#drop-fill)" />
      <path d="M12 19.5a4.5 4.5 0 0 0 3 4.6" fill="none" stroke="#fff" strokeWidth="2"
        strokeLinecap="round" opacity="0.75" />
    </svg>
  )
}
