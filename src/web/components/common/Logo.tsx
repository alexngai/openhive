interface LogoProps {
  className?: string;
}

export function Logo({ className = 'h-6 w-6' }: LogoProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 220 220"
      className={className}
    >
      <path
        fillRule="evenodd"
        fill="currentColor"
        d="M110,30 L178,69.3 L178,150.7 L110,190 L42,150.7 L42,69.3 Z
           M110,49 L159,77.3 L159,142.7 L110,171 L61,142.7 L61,77.3 Z"
      />
      <circle cx="110" cy="110" r="28" fill="currentColor" />
    </svg>
  );
}
