/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        amiri: ['Amiri', 'serif'],
      },
      colors: {
        copper: {
          DEFAULT: '#B8734F',
          50: '#F5EDE0',
          100: '#EDD9C4',
          200: '#D4B896',
          300: '#C09B5F',
          400: '#B8734F',
          500: '#8E4E3A',
          600: '#4A2C2A',
        },
        charcoal: {
          DEFAULT: '#4A4E54',
          700: '#3A3D42',
          800: '#2D2F33',
          900: '#1F2124',
        },
        cream: {
          DEFAULT: '#F5EDE0',
          light: '#FAF7F2',
          50: '#FBF8F3',
          100: '#F5EDE0',
          200: '#EDE1CF',
        },
        sand: {
          DEFAULT: '#D4B896',
          light: '#E5D5BD',
          dark: '#C0A67E',
        },
        terracotta: {
          DEFAULT: '#8E4E3A',
          light: '#A66B53',
        },
        chocolate: {
          DEFAULT: '#4A2C2A',
          light: '#6B4440',
        },
        gold: {
          DEFAULT: '#C09B5F',
          light: '#D4B680',
        },
      },
    },
  },
  plugins: [],
};
