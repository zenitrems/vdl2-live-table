// nav.js — persistent page navigation
const buttons = document.querySelectorAll("#sidebar nav button");
const pages = document.querySelectorAll(".page");

buttons.forEach((btn) => {
  btn.addEventListener("click", () => {
    // switch active button
    buttons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");

    // show the right page
    const target = btn.dataset.page;
    pages.forEach((p) => {
      p.classList.toggle("active", p.id === `page-${target}`);
    });
  });
});

window.dispatchEvent(new Event("navPageLoaded"));